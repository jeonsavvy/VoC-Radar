-- Keep account deletion private-data cleanup atomic and bound the public app
-- directory to one database subrequest regardless of the requested page size.

create index if not exists idx_pipeline_runs_public_app_directory
  on public.pipeline_runs (
    app_store_id,
    country,
    published_at desc nulls last,
    executed_at desc nulls last,
    updated_at desc,
    run_id desc
  )
  where status = 'published' and review_count > 0;

create or replace function public.guard_pipeline_job_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- auth.users deletion uses ON DELETE SET NULL. Scrub the optional user note in
  -- the same statement, including a job queued between deletion preparation and
  -- the Auth Admin delete request.
  if old.requested_by is not null
    and new.requested_by is null
    and (to_jsonb(new) - 'requested_by') = (to_jsonb(old) - 'requested_by') then
    new.note := null;
    return new;
  end if;

  if old.status in ('completed', 'failed', 'canceled') then
    if new is distinct from old then
      if old.note is not null
        and new.note is null
        and (to_jsonb(new) - 'note') = (to_jsonb(old) - 'note') then
        return new;
      end if;
      if (to_jsonb(new) - 'error_message') = (to_jsonb(old) - 'error_message')
        and (
          old.status = 'failed'
            and new.error_message = case
              when old.error_message = 'review_scope_incomplete' then 'review_scope_incomplete'
              else 'The analysis failed. Retry the request.'
            end
          or old.status = 'canceled'
            and new.error_message = 'The analysis request was canceled.'
          or old.status = 'completed'
            and new.error_message is null
        ) then
        return new;
      end if;
      raise exception using errcode = '23514', message = 'terminal pipeline job is immutable';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'queued' and new.status in ('running', 'canceled') then
      null;
    elsif old.status = 'running' and new.status in ('completed', 'failed', 'canceled') then
      null;
    elsif old.status = 'running'
      and new.status = 'queued'
      and old.lease_expires_at is not null
      and old.lease_expires_at <= now()
      and new.claim_key is null
      and new.claim_token is null then
      null;
    else
      raise exception using errcode = '23514', message = 'invalid pipeline job transition';
    end if;
  end if;

  return new;
end;
$$;

-- Accounts deleted before this migration already have no owner UUID. Remove
-- only web-submitted notes; operator reanalysis notes are a separate surface.
update public.pipeline_jobs as job
set note = null
where job.requested_by is null
  and job.source = 'web'
  and job.note is not null;

-- Historical rows may predate the safe failure-message contract and remain
-- directly readable by their owner through RLS. Retain only stable safe values.
update public.pipeline_jobs as job
set error_message = case
  when job.status = 'failed' and job.error_message = 'review_scope_incomplete'
    then 'review_scope_incomplete'
  when job.status = 'failed' then 'The analysis failed. Retry the request.'
  when job.status = 'canceled' then 'The analysis request was canceled.'
  else null
end
where job.status in ('completed', 'failed', 'canceled')
  and (job.source = 'web' or job.requested_by is not null)
  and job.error_message is distinct from case
    when job.status = 'failed' and job.error_message = 'review_scope_incomplete'
      then 'review_scope_incomplete'
    when job.status = 'failed' then 'The analysis failed. Retry the request.'
    when job.status = 'canceled' then 'The analysis request was canceled.'
    else null
  end;

create or replace function public.complete_pipeline_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_stage text default null,
  p_run_id text default null,
  p_error_message text default null
)
returns table (
  job_id uuid,
  status text,
  stage text,
  run_id text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_status text := lower(trim(coalesce(p_status, '')));
  normalized_run_id text := nullif(trim(coalesce(p_run_id, '')), '');
  current_job public.pipeline_jobs;
  safe_error_message text;
begin
  if normalized_status not in ('running', 'completed', 'failed', 'canceled')
    or normalized_run_id is null
    or p_stage is not null and p_stage not in ('queued', 'fetching', 'extracting', 'clustering', 'publishing') then
    raise exception using errcode = '22023', message = 'invalid pipeline status payload';
  end if;

  select pj.* into current_job
  from public.pipeline_jobs as pj
  where pj.id = p_job_id
    and pj.claim_token = p_claim_token
    and (pj.run_id is null or pj.run_id = normalized_run_id)
  for update;

  if current_job.id is null then
    return;
  end if;

  if current_job.status in ('completed', 'failed', 'canceled') then
    if current_job.status = normalized_status and current_job.run_id = normalized_run_id then
      return query select current_job.id, current_job.status, current_job.stage,
        current_job.run_id, current_job.updated_at;
    end if;
    return;
  end if;

  if current_job.status <> 'running'
    or current_job.lease_expires_at is null
    or current_job.lease_expires_at <= now() then
    return;
  end if;

  if normalized_status = 'completed'
    and (
      exists (
        select 1 from public.pipeline_review_ai_staging as staging
        where staging.run_id = normalized_run_id
      )
      or exists (
        select 1 from public.pipeline_runs as pr
        where pr.run_id = normalized_run_id
          and (
            pr.status <> 'published'
            or pr.app_store_id <> current_job.app_store_id
            or pr.country <> current_job.country
          )
      )
    ) then
    raise exception using errcode = '23514', message = 'pipeline run must be published before job completion';
  end if;

  safe_error_message := case
    when normalized_status = 'failed'
      and trim(coalesce(p_error_message, '')) = 'review_scope_incomplete'
      then 'review_scope_incomplete'
    when normalized_status = 'failed' then 'The analysis failed. Retry the request.'
    when normalized_status = 'canceled' then 'The analysis request was canceled.'
    else null
  end;

  update public.pipeline_jobs as pj
  set status = normalized_status,
      stage = case when normalized_status in ('completed', 'failed', 'canceled') then null else coalesce(p_stage, pj.stage) end,
      run_id = coalesce(pj.run_id, normalized_run_id),
      error_message = safe_error_message,
      finished_at = case when normalized_status in ('completed', 'failed', 'canceled') then now() else pj.finished_at end,
      lease_expires_at = case when normalized_status in ('completed', 'failed', 'canceled') then null else now() + interval '15 minutes' end,
      last_heartbeat_at = now(),
      updated_at = now()
  where pj.id = current_job.id
  returning pj.* into current_job;

  if normalized_status in ('failed', 'canceled') then
    update public.pipeline_runs as pr
    set status = 'failed',
        validation_status = 'failed',
        validation_result = jsonb_build_object(
          'passed', false,
          'error', case when normalized_status = 'canceled' then 'job_canceled' else 'pipeline_failed' end
        ),
        updated_at = now()
    where pr.run_id = normalized_run_id
      and pr.status <> 'published';

    delete from public.pipeline_review_ai_staging as staging
    where staging.run_id = normalized_run_id;
  end if;

  update public.pipeline_job_claims as history
  set terminal_status = case when normalized_status in ('completed', 'failed', 'canceled') then normalized_status else history.terminal_status end
  where history.claim_key = current_job.claim_key
    and history.claim_token = current_job.claim_token;

  return query select current_job.id, current_job.status, current_job.stage,
    current_job.run_id, current_job.updated_at;
end;
$$;

create or replace function public.prepare_account_deletion(p_requested_by uuid)
returns table (canceled_jobs bigint, redacted_jobs bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  canceled_count bigint := 0;
  redacted_count bigint := 0;
begin
  if p_requested_by is null then
    raise exception using errcode = '22023', message = 'requested user is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('voc-radar:queue:user:' || p_requested_by::text, 0)
  );

  select count(*) into canceled_count
  from public.cancel_pipeline_jobs(
    p_requested_by,
    null,
    true,
    null,
    null,
    'account_deleted'
  );

  update public.pipeline_jobs as pj
  set note = null
  where pj.requested_by = p_requested_by
    and pj.note is not null;
  get diagnostics redacted_count = row_count;

  return query select canceled_count, redacted_count;
end;
$$;

create or replace function public.get_public_apps(p_limit integer default 20)
returns table (app_store_id text, country text, app_name text, updated_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with latest as (
    select distinct on (run.app_store_id, run.country)
      run.app_store_id,
      run.country,
      coalesce(run.published_at, run.executed_at, run.updated_at) as updated_at
    from public.pipeline_runs as run
    where run.status = 'published'
      and run.review_count > 0
    order by run.app_store_id, run.country,
      run.published_at desc nulls last,
      run.executed_at desc nulls last,
      run.updated_at desc,
      run.run_id desc
  )
  select latest.app_store_id, latest.country, app.app_name, latest.updated_at
  from latest
  left join public.apps as app
    on app.app_store_id = latest.app_store_id
   and app.country = latest.country
  order by latest.updated_at desc, latest.app_store_id, latest.country
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

revoke all on function public.prepare_account_deletion(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_public_apps(integer) from public, anon, authenticated, service_role;
grant execute on function public.prepare_account_deletion(uuid) to service_role;
grant execute on function public.get_public_apps(integer) to service_role;
