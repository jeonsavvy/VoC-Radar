create or replace function public.claim_pipeline_job(
  p_default_app_store_id text default null,
  p_default_country text default null,
  p_default_app_name text default null
)
returns table (
  job_id uuid,
  app_store_id text,
  country text,
  app_name text,
  source text,
  status text,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.pipeline_jobs;
  has_fallback boolean;
  fallback_app_store_id text;
  fallback_country text;
  fallback_app_name text;
begin
  update public.pipeline_jobs as pj
  set status = 'running',
      started_at = now(),
      updated_at = now()
  where pj.id = (
    select q.id
    from public.pipeline_jobs as q
    where q.status = 'queued'
    order by q.requested_at asc
    limit 1
    for update skip locked
  )
  returning pj.* into claimed;

  if claimed.id is not null then
    return query
    select
      claimed.id,
      claimed.app_store_id,
      claimed.country,
      claimed.app_name,
      claimed.source,
      claimed.status,
      claimed.requested_at;
    return;
  end if;

  fallback_app_store_id := nullif(trim(coalesce(p_default_app_store_id, '')), '');
  fallback_country := nullif(trim(coalesce(p_default_country, '')), '');
  fallback_app_name := nullif(trim(coalesce(p_default_app_name, '')), '');
  has_fallback := fallback_app_store_id is not null;

  if has_fallback then
    return query
    select
      null::uuid,
      fallback_app_store_id,
      coalesce(fallback_country, 'kr'),
      fallback_app_name,
      'fallback'::text,
      'fallback'::text,
      now();
  else
    return query
    select
      null::uuid,
      null::text,
      null::text,
      null::text,
      'queue'::text,
      'empty'::text,
      now();
  end if;
end;
$$;

create or replace function public.complete_pipeline_job(
  p_job_id uuid,
  p_status text,
  p_run_id text default null,
  p_error_message text default null
)
returns table (
  job_id uuid,
  status text,
  run_id text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_status text;
begin
  normalized_status := lower(coalesce(trim(p_status), ''));

  if normalized_status not in ('queued', 'running', 'completed', 'failed', 'canceled') then
    raise exception 'invalid job status: %', p_status;
  end if;

  return query
  update public.pipeline_jobs as pj
  set status = normalized_status,
      run_id = coalesce(nullif(trim(coalesce(p_run_id, '')), ''), pj.run_id),
      error_message = case
        when normalized_status = 'failed' then coalesce(p_error_message, pj.error_message)
        else null
      end,
      finished_at = case
        when normalized_status in ('completed', 'failed', 'canceled') then now()
        else pj.finished_at
      end,
      started_at = case
        when normalized_status = 'running' then coalesce(pj.started_at, now())
        else pj.started_at
      end,
      updated_at = now()
  where pj.id = p_job_id
  returning pj.id, pj.status, pj.run_id, pj.updated_at;
end;
$$;
