-- Keep late heartbeats from moving a running pipeline job back to an earlier stage.

create or replace function public.renew_pipeline_job_claim(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_stage text default null
)
returns table (
  job_id uuid,
  status text,
  stage text,
  run_id text,
  lease_expires_at timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_job public.pipeline_jobs;
  normalized_run_id text := nullif(trim(coalesce(p_run_id, '')), '');
  pipeline_stages constant text[] := array['queued', 'fetching', 'extracting', 'clustering', 'publishing'];
begin
  if normalized_run_id is null
    or p_stage is not null and not (p_stage = any(pipeline_stages)) then
    raise exception using errcode = '22023', message = 'invalid pipeline claim payload';
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

  if current_job.status = 'running' then
    if current_job.lease_expires_at is null or current_job.lease_expires_at <= now() then
      return;
    end if;
    if p_stage is not null
      and current_job.stage is not null
      and array_position(pipeline_stages, p_stage) < array_position(pipeline_stages, current_job.stage) then
      return;
    end if;

    update public.pipeline_jobs as pj
    set run_id = coalesce(pj.run_id, normalized_run_id),
        stage = coalesce(p_stage, pj.stage),
        lease_expires_at = now() + interval '15 minutes',
        last_heartbeat_at = now(),
        updated_at = now()
    where pj.id = current_job.id
    returning pj.* into current_job;
  elsif current_job.status not in ('completed', 'failed', 'canceled') then
    return;
  end if;

  return query
  select current_job.id, current_job.status, current_job.stage, current_job.run_id,
    current_job.lease_expires_at, current_job.attempt_count;
end;
$$;

revoke execute on function public.renew_pipeline_job_claim(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.renew_pipeline_job_claim(uuid, uuid, text, text)
  to service_role;

create or replace function public.reject_pipeline_job_stage_regression()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  pipeline_stages constant text[] := array['queued', 'fetching', 'extracting', 'clustering', 'publishing'];
begin
  if old.status = 'running'
    and new.status = 'running'
    and old.stage is not null
    and (
      new.stage is null
      or array_position(pipeline_stages, new.stage) < array_position(pipeline_stages, old.stage)
    ) then
    raise exception using errcode = '23514', message = 'pipeline stage regression rejected';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_pipeline_job_stage_regression()
  from public, anon, authenticated;

drop trigger if exists pipeline_jobs_reject_stage_regression on public.pipeline_jobs;
create trigger pipeline_jobs_reject_stage_regression
before update of status, stage on public.pipeline_jobs
for each row execute function public.reject_pipeline_job_stage_regression();
