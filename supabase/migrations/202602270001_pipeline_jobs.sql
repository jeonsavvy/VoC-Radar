create table if not exists public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  app_store_id text not null,
  country text not null default 'kr',
  app_name text,
  source text not null default 'web',
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  requested_by uuid default auth.uid() references auth.users(id) on delete set null,
  run_id text,
  note text,
  error_message text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pipeline_jobs_status_requested_at
  on public.pipeline_jobs(status, requested_at asc);
create index if not exists idx_pipeline_jobs_requested_by_created_at
  on public.pipeline_jobs(requested_by, created_at desc);

alter table public.pipeline_jobs enable row level security;

drop policy if exists pipeline_jobs_insert_authenticated on public.pipeline_jobs;
create policy pipeline_jobs_insert_authenticated
on public.pipeline_jobs
for insert
to authenticated
with check (requested_by = auth.uid());

drop policy if exists pipeline_jobs_select_own on public.pipeline_jobs;
create policy pipeline_jobs_select_own
on public.pipeline_jobs
for select
to authenticated
using (requested_by = auth.uid());

grant insert, select on table public.pipeline_jobs to authenticated;

create or replace function public.claim_pipeline_job(
  p_default_app_store_id text default '1018769995',
  p_default_country text default 'kr',
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
begin
  update public.pipeline_jobs
  set status = 'running',
      started_at = now(),
      updated_at = now()
  where id = (
    select id
    from public.pipeline_jobs
    where status = 'queued'
    order by requested_at asc
    limit 1
    for update skip locked
  )
  returning * into claimed;

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

  return query
  select
    null::uuid,
    coalesce(nullif(trim(p_default_app_store_id), ''), '1018769995'),
    coalesce(nullif(trim(p_default_country), ''), 'kr'),
    nullif(trim(coalesce(p_default_app_name, '')), ''),
    'fallback'::text,
    'fallback'::text,
    now();
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
  update public.pipeline_jobs
  set status = normalized_status,
      run_id = coalesce(nullif(trim(coalesce(p_run_id, '')), ''), run_id),
      error_message = case
        when normalized_status = 'failed' then coalesce(p_error_message, error_message)
        else null
      end,
      finished_at = case
        when normalized_status in ('completed', 'failed', 'canceled') then now()
        else finished_at
      end,
      started_at = case
        when normalized_status = 'running' then coalesce(started_at, now())
        else started_at
      end,
      updated_at = now()
  where id = p_job_id
  returning pipeline_jobs.id, pipeline_jobs.status, pipeline_jobs.run_id, pipeline_jobs.updated_at;
end;
$$;
