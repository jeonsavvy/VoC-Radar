-- Public intelligence V2 is additive so REPORT_V2_ENABLED can be rolled back
-- without deleting data produced during the rollout.

alter table public.pipeline_jobs
  add column if not exists stage text;

alter table public.pipeline_jobs
  drop constraint if exists pipeline_jobs_stage_check;

alter table public.pipeline_jobs
  add constraint pipeline_jobs_stage_check
  check (stage is null or stage in ('queued', 'fetching', 'extracting', 'clustering', 'publishing'));

alter table public.pipeline_runs
  add column if not exists model_version text,
  add column if not exists validation_status text,
  add column if not exists validation_result jsonb;

alter table public.pipeline_runs
  drop constraint if exists pipeline_runs_validation_status_check;

alter table public.pipeline_runs
  add constraint pipeline_runs_validation_status_check
  check (validation_status is null or validation_status in ('passed', 'failed'));

create unique index if not exists uq_pipeline_jobs_one_active_app
  on public.pipeline_jobs (app_store_id, country)
  where status in ('queued', 'running');

create table if not exists public.issue_clusters (
  id uuid primary key default gen_random_uuid(),
  app_store_id text not null,
  country text not null default 'kr',
  canonical_key text not null,
  title text not null,
  category text not null check (category in (
    '버그 및 성능',
    '계정 및 결제',
    '기능 및 사용성',
    '콘텐츠 및 운영 정책',
    '긍정 리뷰 및 기타'
  )),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  current_run_id text references public.pipeline_runs(run_id) on delete set null,
  model_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_store_id, country, canonical_key)
);

create table if not exists public.issue_cluster_snapshots (
  cluster_id uuid not null references public.issue_clusters(id) on delete cascade,
  run_id text not null references public.pipeline_runs(run_id) on delete cascade,
  severity text not null check (severity in ('high', 'medium', 'low')),
  review_count integer not null check (review_count >= 1),
  previous_review_count integer,
  change_percent numeric(8, 1),
  evidence_count integer not null check (evidence_count >= 1),
  summary text not null,
  action_hint text,
  window_from timestamptz,
  window_to timestamptz,
  validation_status text not null default 'passed' check (validation_status in ('passed', 'failed')),
  validation_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (cluster_id, run_id),
  check (
    (previous_review_count is null and change_percent is null)
    or previous_review_count > 0
  )
);

create table if not exists public.issue_cluster_reviews (
  run_id text not null references public.pipeline_runs(run_id) on delete cascade,
  review_id text not null references public.reviews(review_id) on delete cascade,
  cluster_id uuid not null references public.issue_clusters(id) on delete cascade,
  is_representative boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (run_id, review_id),
  foreign key (cluster_id, run_id)
    references public.issue_cluster_snapshots(cluster_id, run_id) on delete cascade
);

create index if not exists idx_issue_clusters_app_updated
  on public.issue_clusters (app_store_id, country, updated_at desc);

create index if not exists idx_issue_cluster_snapshots_run
  on public.issue_cluster_snapshots (run_id, review_count desc);

create index if not exists idx_issue_cluster_reviews_cluster_run
  on public.issue_cluster_reviews (cluster_id, run_id);

alter table public.issue_clusters enable row level security;
alter table public.issue_cluster_snapshots enable row level security;
alter table public.issue_cluster_reviews enable row level security;

revoke all on table public.issue_clusters from anon, authenticated;
revoke all on table public.issue_cluster_snapshots from anon, authenticated;
revoke all on table public.issue_cluster_reviews from anon, authenticated;

create or replace function public.get_public_issue_clusters(
  p_app_store_id text,
  p_country text default 'kr',
  p_limit integer default 50
)
returns table (
  issue_id uuid,
  title text,
  category text,
  severity text,
  review_count integer,
  change_percent numeric,
  evidence_count integer,
  last_occurred_at timestamptz,
  summary text,
  action_hint text,
  run_id text,
  model_version text,
  analyzed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.title,
    c.category,
    s.severity,
    s.review_count,
    s.change_percent,
    s.evidence_count,
    c.last_seen_at,
    s.summary,
    s.action_hint,
    s.run_id,
    c.model_version,
    coalesce(r.published_at, r.updated_at, s.created_at)
  from public.issue_clusters c
  join lateral (
    select candidate.*
    from public.issue_cluster_snapshots candidate
    join public.pipeline_runs candidate_run on candidate_run.run_id = candidate.run_id
    where candidate.cluster_id = c.id
      and candidate.validation_status = 'passed'
      and candidate_run.status = 'published'
      and candidate_run.validation_status = 'passed'
    order by candidate_run.published_at desc nulls last, candidate_run.updated_at desc
    limit 1
  ) s on true
  join public.pipeline_runs r on r.run_id = s.run_id
  where c.app_store_id = p_app_store_id
    and c.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
  order by
    case s.severity when 'high' then 1 when 'medium' then 2 else 3 end,
    s.review_count desc,
    c.last_seen_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

create or replace function public.get_public_issue_detail(p_issue_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'issue', jsonb_build_object(
      'issueId', c.id,
      'appStoreId', c.app_store_id,
      'country', c.country,
      'title', c.title,
      'category', c.category,
      'severity', s.severity,
      'reviewCount', s.review_count,
      'changePercent', s.change_percent,
      'evidenceCount', s.evidence_count,
      'lastOccurredAt', c.last_seen_at,
      'summary', s.summary,
      'actionHint', s.action_hint,
      'runId', s.run_id,
      'modelVersion', c.model_version,
      'validation', s.validation_result,
      'analyzedAt', coalesce(pr.published_at, pr.updated_at, s.created_at)
    ),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reviewId', r.review_id,
        'rating', r.rating,
        'author', r.author,
        'content', r.content,
        'reviewedAt', r.reviewed_at,
        'summary', ai.summary,
        'isRepresentative', cr.is_representative
      ) order by cr.is_representative desc, r.reviewed_at desc)
      from public.issue_cluster_reviews cr
      join public.reviews r on r.review_id = cr.review_id
      left join public.review_ai ai on ai.review_id = r.review_id
      where cr.cluster_id = c.id and cr.run_id = s.run_id
    ), '[]'::jsonb)
  )
  from public.issue_clusters c
  join lateral (
    select candidate.*
    from public.issue_cluster_snapshots candidate
    join public.pipeline_runs candidate_run on candidate_run.run_id = candidate.run_id
    where candidate.cluster_id = c.id
      and candidate.validation_status = 'passed'
      and candidate_run.status = 'published'
      and candidate_run.validation_status = 'passed'
    order by candidate_run.published_at desc nulls last, candidate_run.updated_at desc
    limit 1
  ) s on true
  join public.pipeline_runs pr on pr.run_id = s.run_id
  where c.id = p_issue_id;
$$;

revoke all on function public.get_public_issue_clusters(text, text, integer) from public;
revoke all on function public.get_public_issue_detail(uuid) from public;
grant execute on function public.get_public_issue_clusters(text, text, integer) to anon, authenticated;
grant execute on function public.get_public_issue_detail(uuid) to anon, authenticated;
