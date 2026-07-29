-- Expand: let the service-role Worker enqueue jobs before authenticated
-- inserts are removed in the separately deployed contract migration.

grant insert on table public.pipeline_jobs to service_role;

-- Enqueue web jobs atomically and enforce a race-safe rolling user quota.

create index if not exists idx_pipeline_jobs_web_user_requested_at
  on public.pipeline_jobs (requested_by, requested_at)
  where requested_by is not null and source = 'web';

create or replace function public.enqueue_pipeline_job(
  p_app_store_id text,
  p_country text default 'kr',
  p_app_name text default null,
  p_note text default null,
  p_requested_by uuid default null,
  p_daily_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_app_store_id text := nullif(trim(coalesce(p_app_store_id, '')), '');
  normalized_country text := lower(coalesce(nullif(trim(p_country), ''), 'kr'));
  normalized_app_name text := nullif(trim(coalesce(p_app_name, '')), '');
  normalized_note text := nullif(trim(coalesce(p_note, '')), '');
  effective_daily_limit integer := least(greatest(coalesce(p_daily_limit, 10), 1), 100);
  quota_now timestamptz := clock_timestamp();
  recent_job_count integer;
  quota_retry_at timestamptz;
  stored_app_name text;
  active_job public.pipeline_jobs%rowtype;
  created_job public.pipeline_jobs%rowtype;
begin
  if normalized_app_store_id is null
    or normalized_app_store_id !~ '^[0-9]{5,20}$'
    or normalized_country !~ '^[a-z]{2}$'
    or p_requested_by is null
    or length(coalesce(normalized_app_name, '')) > 120
    or length(coalesce(normalized_note, '')) > 300 then
    raise exception using errcode = '22023', message = 'invalid pipeline enqueue payload';
  end if;

  -- A user lock makes the count-and-insert boundary serializable without
  -- blocking unrelated users. The app lock serializes the active-job lookup.
  perform pg_advisory_xact_lock(
    hashtextextended('voc-radar:queue:user:' || p_requested_by::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('voc-radar:queue:app:' || normalized_app_store_id || ':' || normalized_country, 0)
  );

  select pj.* into active_job
  from public.pipeline_jobs as pj
  where pj.app_store_id = normalized_app_store_id
    and pj.country = normalized_country
    and pj.status in ('queued', 'running')
  order by pj.requested_at asc, pj.id asc
  limit 1;

  if active_job.id is not null then
    return jsonb_build_object(
      'result', 'existing',
      'data', jsonb_build_object(
        'id', active_job.id,
        'app_store_id', active_job.app_store_id,
        'country', active_job.country,
        'app_name', active_job.app_name,
        'status', active_job.status,
        'stage', active_job.stage,
        'run_id', active_job.run_id,
        'requested_at', active_job.requested_at,
        'updated_at', active_job.updated_at
      )
    );
  end if;

  select count(*)::integer
    into recent_job_count
  from public.pipeline_jobs as pj
  where pj.requested_by = p_requested_by
    and pj.source = 'web'
    and pj.requested_at >= quota_now - interval '24 hours';

  if recent_job_count >= effective_daily_limit then
    select pj.requested_at + interval '24 hours'
      into quota_retry_at
    from public.pipeline_jobs as pj
    where pj.requested_by = p_requested_by
      and pj.source = 'web'
      and pj.requested_at >= quota_now - interval '24 hours'
    order by pj.requested_at asc, pj.id asc
    offset greatest(recent_job_count - effective_daily_limit, 0)
    limit 1;

    return jsonb_build_object(
      'result', 'quota_exceeded',
      'retryAt', quota_retry_at
    );
  end if;

  if normalized_app_name is null then
    insert into public.apps (app_store_id, country, app_name, updated_at)
    values (normalized_app_store_id, normalized_country, null, quota_now)
    on conflict (app_store_id, country) do nothing;
  else
    insert into public.apps as existing (app_store_id, country, app_name, updated_at)
    values (normalized_app_store_id, normalized_country, normalized_app_name, quota_now)
    on conflict (app_store_id, country) do update
    set app_name = excluded.app_name,
        updated_at = excluded.updated_at
    where existing.app_name is distinct from excluded.app_name;
  end if;

  select app.app_name into stored_app_name
  from public.apps as app
  where app.app_store_id = normalized_app_store_id
    and app.country = normalized_country;

  begin
    insert into public.pipeline_jobs (
      app_store_id,
      country,
      app_name,
      note,
      source,
      status,
      stage,
      requested_by,
      requested_at,
      updated_at
    ) values (
      normalized_app_store_id,
      normalized_country,
      stored_app_name,
      normalized_note,
      'web',
      'queued',
      'queued',
      p_requested_by,
      quota_now,
      quota_now
    )
    returning * into created_job;
  exception
    when unique_violation then
      select pj.* into active_job
      from public.pipeline_jobs as pj
      where pj.app_store_id = normalized_app_store_id
        and pj.country = normalized_country
        and pj.status in ('queued', 'running')
      order by pj.requested_at asc, pj.id asc
      limit 1;

      if active_job.id is null then
        raise;
      end if;

      return jsonb_build_object(
        'result', 'existing',
        'data', jsonb_build_object(
          'id', active_job.id,
          'app_store_id', active_job.app_store_id,
          'country', active_job.country,
          'app_name', active_job.app_name,
          'status', active_job.status,
          'stage', active_job.stage,
          'run_id', active_job.run_id,
          'requested_at', active_job.requested_at,
          'updated_at', active_job.updated_at
        )
      );
  end;

  return jsonb_build_object(
    'result', 'queued',
    'data', jsonb_build_object(
      'id', created_job.id,
      'app_store_id', created_job.app_store_id,
      'country', created_job.country,
      'app_name', created_job.app_name,
      'status', created_job.status,
      'stage', created_job.stage,
      'run_id', created_job.run_id,
      'requested_at', created_job.requested_at,
      'updated_at', created_job.updated_at
    )
  );
end;
$$;

revoke execute on function public.enqueue_pipeline_job(text, text, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_pipeline_job(text, text, text, text, uuid, integer)
  to service_role;
