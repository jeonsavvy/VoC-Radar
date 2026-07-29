-- Canonical schema for a new VoC Radar Supabase project.
-- Apply this file once to an empty project. Upgrade existing projects with migrations/.

-- -----------------------------------------------------------------------------
-- extension
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- table: 앱 메타 / 리뷰 원문 / AI 분류 / 실행 이력
-- -----------------------------------------------------------------------------
create table if not exists public.apps (
  id uuid primary key default gen_random_uuid(),
  app_store_id text not null,
  country text not null default 'kr',
  app_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_store_id, country)
);

create table if not exists public.reviews (
  review_id text primary key,
  app_store_id text not null,
  country text not null default 'kr',
  rating smallint not null check (rating between 1 and 5),
  author text not null,
  content text not null,
  reviewed_at timestamptz not null,
  raw_source jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_ai (
  review_id text primary key references public.reviews(review_id) on delete cascade,
  priority text not null,
  category text not null,
  issue_label text,
  reason_summary text,
  action_hint text,
  summary text not null,
  confidence numeric(5,4),
  model_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  run_id text not null unique,
  app_store_id text not null,
  country text not null default 'kr',
  source text not null default 'n8n',
  status text not null check (status in ('upserted', 'published', 'failed')),
  review_count integer not null default 0,
  executed_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.parse_errors (
  id uuid primary key default gen_random_uuid(),
  parse_error_id text not null unique,
  run_id text,
  app_store_id text,
  country text,
  message text not null,
  raw_response text,
  created_at timestamptz not null default now()
);

create table if not exists public.alert_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  run_id text not null,
  review_id text not null,
  app_store_id text not null,
  country text not null default 'kr',
  rating smallint not null check (rating between 1 and 5),
  priority text not null,
  category text not null,
  summary text not null,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

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

-- -----------------------------------------------------------------------------
-- index
-- -----------------------------------------------------------------------------
create index if not exists idx_reviews_app_country_reviewed_at on public.reviews(app_store_id, country, reviewed_at desc);
create index if not exists idx_reviews_rating on public.reviews(rating);
create index if not exists idx_review_ai_priority on public.review_ai(priority);
create index if not exists idx_pipeline_runs_run_id on public.pipeline_runs(run_id);
create index if not exists idx_parse_errors_run_id on public.parse_errors(run_id);
create index if not exists idx_alert_events_run_id on public.alert_events(run_id);
create index if not exists idx_pipeline_jobs_status_requested_at on public.pipeline_jobs(status, requested_at asc);
create index if not exists idx_pipeline_jobs_requested_by_created_at on public.pipeline_jobs(requested_by, created_at desc);

-- -----------------------------------------------------------------------------
-- constraint
-- -----------------------------------------------------------------------------
alter table public.review_ai drop constraint if exists review_ai_priority_check;
alter table public.review_ai add constraint review_ai_priority_check
  check (priority in ('Critical', 'High', 'Normal'));

alter table public.review_ai drop constraint if exists review_ai_category_check;
alter table public.review_ai add constraint review_ai_category_check
  check (category in ('버그 및 성능', '계정 및 결제', '콘텐츠 및 운영 정책', '기능 및 사용성', '긍정 리뷰 및 기타'));

-- -----------------------------------------------------------------------------
-- RLS / policy
-- -----------------------------------------------------------------------------
alter table public.apps enable row level security;
alter table public.reviews enable row level security;
alter table public.review_ai enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.parse_errors enable row level security;
alter table public.alert_events enable row level security;
alter table public.pipeline_jobs enable row level security;

drop policy if exists apps_read_public on public.apps;
create policy apps_read_public on public.apps
for select to anon, authenticated
using (true);

drop policy if exists reviews_read_authenticated on public.reviews;
create policy reviews_read_authenticated on public.reviews
for select to authenticated
using (true);

drop policy if exists review_ai_read_authenticated on public.review_ai;
create policy review_ai_read_authenticated on public.review_ai
for select to authenticated
using (true);

drop policy if exists pipeline_jobs_insert_authenticated on public.pipeline_jobs;

drop policy if exists pipeline_jobs_select_own on public.pipeline_jobs;
create policy pipeline_jobs_select_own
on public.pipeline_jobs
for select
to authenticated
using (requested_by = (select auth.uid()));

revoke insert on table public.pipeline_jobs from public, anon, authenticated;
grant select on table public.pipeline_jobs to authenticated;
grant insert on table public.pipeline_jobs to service_role;

-- -----------------------------------------------------------------------------
-- public function: 표시용 유형 정규화
-- -----------------------------------------------------------------------------
create or replace function public.normalize_review_category(
  p_category text,
  p_summary text default '',
  p_content text default ''
)
returns text
language sql
immutable
set search_path = public
as $$
  with src as (
    select lower(concat_ws(' ', coalesce(p_category, ''), coalesce(p_summary, ''), coalesce(p_content, ''))) as source
  )
  select case
    when source ~ '(버그|오류|에러|튕|크래시|멈춤|먹통|작동.?안|실행.?안|느림|지연|렉|버벅|속도|발열|배터리|프리징|로딩|lag|slow|performance|stability|bug|error|crash|fail)' then '버그 및 성능'
    when source ~ '(결제|구독|환불|인앱|구매|billing|payment|subscription|refund|로그인|log in|login|계정|인증|회원가입|가입|account|auth|sign in|sign-in|signin)' then '계정 및 결제'
    when source ~ '(콘텐츠|커뮤니티|운영|정책|약관|규정|신고|정지|제재|차단|검수|게시글|피드|노출|알림|고객센터|문의|응대|content|community|policy|moderation|report|ban|suspend|support)' then '콘텐츠 및 운영 정책'
    when source ~ '(사용성|불편|ui|ux|디자인|가독성|동선|메뉴|접근성|편의|요청|기능.?추가|추가해|개선해|지원해|원해|feature request|please add|wish)' then '기능 및 사용성'
    when source ~ '(칭찬|좋아|좋음|최고|만족|감사|추천|great|love|excellent|awesome)' then '긍정 리뷰 및 기타'
    else '긍정 리뷰 및 기타'
  end
  from src;
$$;

-- -----------------------------------------------------------------------------
-- view: 리뷰 상세 read model
-- security_invoker=true로 실행자 권한/RLS를 따르게 해 Supabase Security Definer 경고를 피한다.
-- 직접 DB 노출은 막고 Worker가 서비스 권한으로 조회한다.
-- -----------------------------------------------------------------------------
drop view if exists public.private_review_feed;
create view public.private_review_feed with (security_invoker = true) as
select
  r.review_id,
  r.app_store_id,
  r.country,
  r.rating,
  r.author,
  r.content,
  r.reviewed_at,
  ai.priority,
  public.normalize_review_category(ai.category, ai.summary, r.content) as category,
  ai.summary,
  ai.confidence,
  coalesce(nullif(trim(ai.issue_label), ''), public.normalize_review_category(ai.category, ai.summary, r.content)) as issue_label,
  coalesce(nullif(trim(ai.reason_summary), ''), ai.summary) as reason_summary,
  coalesce(nullif(trim(ai.action_hint), ''), '후속 조치가 필요합니다.') as action_hint
from public.reviews r
join public.review_ai ai using (review_id);

revoke all on table public.private_review_feed from anon, authenticated;
grant select on table public.private_review_feed to service_role;

-- -----------------------------------------------------------------------------
-- public rpc: 대시보드 집계
-- -----------------------------------------------------------------------------
create or replace function public.get_public_overview(
  p_app_store_id text,
  p_country text default 'kr',
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns table (
  app_store_id text,
  country text,
  total_reviews bigint,
  critical_count bigint,
  low_rating_count bigint,
  average_rating numeric,
  positive_ratio numeric,
  last_review_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select
      r.review_id,
      r.app_store_id,
      r.country,
      r.rating,
      r.reviewed_at,
      ai.priority
    from public.reviews r
    join public.review_ai ai using (review_id)
    where r.app_store_id = p_app_store_id
      and r.country = p_country
      and r.reviewed_at >= coalesce(p_from, now() - interval '30 days')
      and r.reviewed_at <= coalesce(p_to, now())
  )
  select
    p_app_store_id,
    p_country,
    count(*)::bigint as total_reviews,
    count(*) filter (
      where lower(replace(replace(replace(coalesce(priority, ''), '🚨', ''), '⚠️', ''), '✅', '')) like '%critical%'
    )::bigint as critical_count,
    count(*) filter (where rating <= 2)::bigint as low_rating_count,
    coalesce(avg(rating::numeric), 0)::numeric(5,2) as average_rating,
    coalesce((count(*) filter (where rating >= 4)::numeric / nullif(count(*), 0)::numeric) * 100, 0)::numeric(5,2)
      as positive_ratio,
    max(reviewed_at) as last_review_at
  from scoped;
$$;

create or replace function public.get_public_trends(
  p_app_store_id text,
  p_country text default 'kr',
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns table (
  bucket_date date,
  total_reviews bigint,
  critical_count bigint,
  average_rating numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    date_trunc('day', r.reviewed_at)::date as bucket_date,
    count(*)::bigint as total_reviews,
    count(*) filter (
      where lower(replace(replace(replace(coalesce(ai.priority, ''), '🚨', ''), '⚠️', ''), '✅', '')) like '%critical%'
    )::bigint as critical_count,
    coalesce(avg(r.rating::numeric), 0)::numeric(5,2) as average_rating
  from public.reviews r
  join public.review_ai ai using (review_id)
  where r.app_store_id = p_app_store_id
    and r.country = p_country
    and r.reviewed_at >= coalesce(p_from, now() - interval '30 days')
    and r.reviewed_at <= coalesce(p_to, now())
  group by 1
  order by 1;
$$;

create or replace function public.get_public_categories(
  p_app_store_id text,
  p_country text default 'kr',
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns table (
  category text,
  total_reviews bigint,
  share_percent numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select public.normalize_review_category(ai.category, ai.summary, r.content) as category
    from public.reviews r
    join public.review_ai ai using (review_id)
    where r.app_store_id = p_app_store_id
      and r.country = p_country
      and r.reviewed_at >= coalesce(p_from, now() - interval '30 days')
      and r.reviewed_at <= coalesce(p_to, now())
  ),
  counts as (
    select category, count(*)::bigint as total_reviews
    from scoped
    group by category
  )
  select
    category,
    total_reviews,
    coalesce((total_reviews::numeric / nullif(sum(total_reviews) over (), 0)::numeric) * 100, 0)::numeric(5,2)
      as share_percent
  from counts
  order by total_reviews desc, category asc;
$$;

create or replace function public.get_public_issues(
  p_app_store_id text,
  p_country text default 'kr',
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now(),
  p_limit integer default 10
)
returns table (
  issue_label text,
  category text,
  review_count bigint,
  critical_count bigint,
  low_rating_count bigint,
  average_rating numeric,
  last_review_at timestamptz,
  previous_review_count bigint,
  change_percent numeric,
  reason_summary text,
  action_hint text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      coalesce(p_from, now() - interval '30 days') as from_at,
      coalesce(p_to, now()) as to_at,
      greatest(coalesce(p_limit, 10), 1) as row_limit
  ),
  current_rows as (
    select
      coalesce(nullif(trim(ai.issue_label), ''), public.normalize_review_category(ai.category, ai.summary, r.content)) as issue_label,
      public.normalize_review_category(ai.category, ai.summary, r.content) as category,
      ai.priority,
      r.rating,
      r.reviewed_at,
      coalesce(nullif(trim(ai.reason_summary), ''), ai.summary) as reason_summary,
      coalesce(nullif(trim(ai.action_hint), ''), '후속 조치가 필요합니다.') as action_hint
    from public.reviews r
    join public.review_ai ai using (review_id)
    cross join params
    where r.app_store_id = p_app_store_id
      and r.country = p_country
      and r.reviewed_at >= params.from_at
      and r.reviewed_at <= params.to_at
  ),
  previous_rows as (
    select
      coalesce(nullif(trim(ai.issue_label), ''), public.normalize_review_category(ai.category, ai.summary, r.content)) as issue_label
    from public.reviews r
    join public.review_ai ai using (review_id)
    cross join params
    where r.app_store_id = p_app_store_id
      and r.country = p_country
      and r.reviewed_at >= params.from_at - (params.to_at - params.from_at)
      and r.reviewed_at < params.from_at
  ),
  previous_counts as (
    select issue_label, count(*)::bigint as previous_review_count
    from previous_rows
    group by issue_label
  ),
  ranked_reasons as (
    select
      issue_label,
      category,
      reason_summary,
      action_hint,
      row_number() over (
        partition by issue_label
        order by reviewed_at desc
      ) as row_number
    from current_rows
  ),
  merged as (
    select
      current_rows.issue_label,
      min(current_rows.category) as category,
      count(*)::bigint as review_count,
      count(*) filter (where current_rows.rating <= 2)::bigint as low_rating_count,
      count(*) filter (
        where current_rows.priority = 'Critical'
          or (
            current_rows.rating = 1
            and current_rows.category in ('버그 및 성능', '계정 및 결제')
          )
      )::bigint as critical_count,
      coalesce(avg(current_rows.rating::numeric), 0)::numeric(5,2) as average_rating,
      max(current_rows.reviewed_at) as last_review_at,
      coalesce(previous_counts.previous_review_count, 0)::bigint as previous_review_count
    from current_rows
    left join previous_counts on previous_counts.issue_label = current_rows.issue_label
    group by current_rows.issue_label, previous_counts.previous_review_count
  )
  select
    merged.issue_label,
    merged.category,
    merged.review_count,
    merged.critical_count,
    merged.low_rating_count,
    merged.average_rating,
    merged.last_review_at,
    merged.previous_review_count,
    case
      when merged.previous_review_count = 0 then null
      else round(((merged.review_count - merged.previous_review_count)::numeric / merged.previous_review_count::numeric) * 100, 1)
    end as change_percent,
    ranked_reasons.reason_summary,
    ranked_reasons.action_hint
  from merged
  left join ranked_reasons
    on ranked_reasons.issue_label = merged.issue_label
   and ranked_reasons.row_number = 1
  order by merged.critical_count desc, merged.low_rating_count desc, merged.review_count desc, merged.last_review_at desc
  limit (select row_limit from params);
$$;

-- -----------------------------------------------------------------------------
-- internal/public function: 신규 리뷰 필터링과 queue 제어
-- -----------------------------------------------------------------------------
create or replace function public.get_existing_review_ids(
  p_app_store_id text,
  p_country text default 'kr',
  p_review_ids text[] default '{}'
)
returns table (
  review_id text
)
language sql
stable
security definer
set search_path = public
as $$
  select r.review_id
  from public.reviews r
  where r.app_store_id = p_app_store_id
    and r.country = p_country
    and r.review_id = any(coalesce(p_review_ids, '{}'));
$$;

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

-- -----------------------------------------------------------------------------
-- function execute grant
-- -----------------------------------------------------------------------------
grant execute on function public.get_public_overview(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_trends(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_categories(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_issues(text, text, timestamptz, timestamptz, integer) to anon, authenticated;

-- Pipeline control RPCs are service-role only. SECURITY DEFINER functions are
-- executable by PUBLIC unless the default grant is revoked explicitly.
revoke execute on function public.get_existing_review_ids(text, text, text[])
  from public, anon, authenticated;
revoke execute on function public.claim_pipeline_job(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.complete_pipeline_job(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.get_existing_review_ids(text, text, text[])
  to service_role;
grant execute on function public.claim_pipeline_job(text, text, text)
  to service_role;
grant execute on function public.complete_pipeline_job(uuid, text, text, text)
  to service_role;

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

create index if not exists idx_issue_cluster_reviews_review
  on public.issue_cluster_reviews (review_id);

create index if not exists idx_issue_clusters_current_run
  on public.issue_clusters (current_run_id);

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
  with latest_run as (
    select pr.run_id, pr.published_at, pr.updated_at
    from public.pipeline_runs pr
    where pr.app_store_id = p_app_store_id
      and pr.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
      and pr.status = 'published'
      and pr.validation_status = 'passed'
    order by pr.published_at desc nulls last, pr.updated_at desc
    limit 1
  )
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
    coalesce(latest_run.published_at, latest_run.updated_at, s.created_at)
  from latest_run
  join public.issue_cluster_snapshots s
    on s.run_id = latest_run.run_id
   and s.validation_status = 'passed'
  join public.issue_clusters c on c.id = s.cluster_id
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
  with target_cluster as (
    select c.*
    from public.issue_clusters c
    where c.id = p_issue_id
  ), latest_run as (
    select pr.run_id, pr.published_at, pr.updated_at
    from public.pipeline_runs pr
    join target_cluster c
      on c.app_store_id = pr.app_store_id
     and c.country = pr.country
    where pr.status = 'published'
      and pr.validation_status = 'passed'
    order by pr.published_at desc nulls last, pr.updated_at desc
    limit 1
  )
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
      'analyzedAt', coalesce(latest_run.published_at, latest_run.updated_at, s.created_at)
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
  from target_cluster c
  join latest_run on true
  join public.issue_cluster_snapshots s
    on s.cluster_id = c.id
   and s.run_id = latest_run.run_id
   and s.validation_status = 'passed';
$$;

revoke all on function public.get_public_issue_clusters(text, text, integer) from public;
revoke all on function public.get_public_issue_detail(uuid) from public;
grant execute on function public.get_public_issue_clusters(text, text, integer) to anon, authenticated;
grant execute on function public.get_public_issue_detail(uuid) to anon, authenticated;

-- Supabase may provide this event-trigger helper outside this schema. It
-- must not become a callable PostgREST RPC when it exists.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated, service_role';
  end if;
end;
$$;


-- Queue leases, claim fencing, and atomic pipeline persistence.
-- This migration is additive. Rollback is performed by deploying the previous
-- Worker/workflow; the new columns, tables, and RPCs may remain in place.

create extension if not exists pgcrypto;

alter table public.pipeline_jobs
  add column if not exists claim_key text,
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

alter table public.pipeline_jobs
  drop constraint if exists pipeline_jobs_attempt_count_check;

alter table public.pipeline_jobs
  add constraint pipeline_jobs_attempt_count_check check (attempt_count >= 0);

create unique index if not exists uq_pipeline_jobs_claim_key
  on public.pipeline_jobs (claim_key)
  where claim_key is not null;

create index if not exists idx_pipeline_jobs_expired_lease
  on public.pipeline_jobs (lease_expires_at)
  where status = 'running';

create table if not exists public.pipeline_job_claims (
  claim_key text primary key,
  job_id uuid not null references public.pipeline_jobs(id) on delete cascade,
  claim_token uuid not null,
  attempt_count integer not null check (attempt_count >= 1),
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  expired_at timestamptz,
  terminal_status text check (terminal_status is null or terminal_status in ('expired', 'completed', 'failed', 'canceled'))
);

create index if not exists idx_pipeline_job_claims_job
  on public.pipeline_job_claims (job_id, attempt_count desc);

alter table public.pipeline_job_claims enable row level security;
revoke all on table public.pipeline_job_claims from public, anon, authenticated;
grant select, insert, update on table public.pipeline_job_claims to service_role;

-- AI classifications remain private to one run until that run is published.
-- New raw review rows may exist before publication, but every public review
-- surface joins review_ai, so only classifications merged at publish are visible.
create unique index if not exists uq_reviews_id_scope
  on public.reviews (review_id, app_store_id, country);

create table if not exists public.pipeline_review_ai_staging (
  run_id text not null references public.pipeline_runs(run_id) on delete cascade,
  review_id text not null,
  app_store_id text not null,
  country text not null,
  rating smallint not null,
  author text not null,
  content text not null,
  reviewed_at timestamptz not null,
  raw_source jsonb,
  priority text not null check (priority in ('Critical', 'High', 'Normal')),
  category text not null check (category in (
    '버그 및 성능',
    '계정 및 결제',
    '기능 및 사용성',
    '콘텐츠 및 운영 정책',
    '긍정 리뷰 및 기타'
  )),
  issue_label text,
  reason_summary text,
  action_hint text,
  summary text not null,
  confidence numeric(5,4),
  model_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, review_id),
  constraint pipeline_review_ai_staging_review_scope_fkey
    foreign key (review_id, app_store_id, country)
    references public.reviews (review_id, app_store_id, country)
    on delete cascade
);

-- Keep a partially applied pre-release schema upgradeable without exposing
-- nullable raw values to publish_pipeline_run.
alter table public.pipeline_review_ai_staging
  add column if not exists rating smallint,
  add column if not exists author text,
  add column if not exists content text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists raw_source jsonb;

delete from public.pipeline_review_ai_staging as staging
using public.reviews as review
where review.review_id = staging.review_id
  and (review.app_store_id <> staging.app_store_id or review.country <> staging.country);

update public.pipeline_review_ai_staging as staging
set rating = coalesce(staging.rating, review.rating),
    author = coalesce(staging.author, review.author),
    content = coalesce(staging.content, review.content),
    reviewed_at = coalesce(staging.reviewed_at, review.reviewed_at),
    raw_source = coalesce(staging.raw_source, review.raw_source)
from public.reviews as review
where review.review_id = staging.review_id
  and (staging.rating is null or staging.author is null
    or staging.content is null or staging.reviewed_at is null);

alter table public.pipeline_review_ai_staging
  alter column rating set not null,
  alter column author set not null,
  alter column content set not null,
  alter column reviewed_at set not null;

alter table public.pipeline_review_ai_staging
  drop constraint if exists pipeline_review_ai_staging_rating_check;
alter table public.pipeline_review_ai_staging
  add constraint pipeline_review_ai_staging_rating_check check (rating between 1 and 5);

alter table public.pipeline_review_ai_staging
  drop constraint if exists pipeline_review_ai_staging_review_scope_fkey;
alter table public.pipeline_review_ai_staging
  add constraint pipeline_review_ai_staging_review_scope_fkey
  foreign key (review_id, app_store_id, country)
  references public.reviews (review_id, app_store_id, country)
  on delete cascade;

create index if not exists idx_pipeline_review_ai_staging_review
  on public.pipeline_review_ai_staging (review_id);
create index if not exists idx_pipeline_review_ai_staging_review_scope
  on public.pipeline_review_ai_staging (review_id, app_store_id, country);

alter table public.pipeline_review_ai_staging enable row level security;
revoke all on table public.pipeline_review_ai_staging from public, anon, authenticated;
grant select, insert, update, delete on table public.pipeline_review_ai_staging to service_role;

-- Authenticated direct Supabase reads see only reviews whose AI classification
-- has been committed by publish_pipeline_run. Raw rows for failed, canceled,
-- expired, or still-staged runs remain service-role-only pipeline state.
drop policy if exists reviews_read_authenticated on public.reviews;
create policy reviews_read_authenticated on public.reviews
for select to authenticated
using (
  exists (
    select 1
    from public.review_ai as committed_ai
    where committed_ai.review_id = reviews.review_id
  )
);

alter table public.issue_cluster_snapshots
  add column if not exists title text,
  add column if not exists category text,
  add column if not exists first_seen_at timestamptz,
  add column if not exists last_seen_at timestamptz,
  add column if not exists model_version text;

update public.issue_cluster_snapshots as s
set title = coalesce(s.title, c.title),
    category = coalesce(s.category, c.category),
    first_seen_at = coalesce(s.first_seen_at, c.first_seen_at),
    last_seen_at = coalesce(s.last_seen_at, c.last_seen_at),
    model_version = coalesce(s.model_version, c.model_version)
from public.issue_clusters as c
where c.id = s.cluster_id
  and (s.title is null
    or s.category is null
    or s.first_seen_at is null
    or s.last_seen_at is null
    or s.model_version is null);

alter table public.issue_cluster_snapshots
  alter column title set not null,
  alter column category set not null,
  alter column first_seen_at set not null,
  alter column last_seen_at set not null,
  alter column model_version set not null;

alter table public.issue_cluster_snapshots
  drop constraint if exists issue_cluster_snapshots_category_check;

alter table public.issue_cluster_snapshots
  add constraint issue_cluster_snapshots_category_check check (category in (
    '버그 및 성능',
    '계정 및 결제',
    '기능 및 사용성',
    '콘텐츠 및 운영 정책',
    '긍정 리뷰 및 기타'
  ));

create or replace function public.guard_pipeline_job_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status in ('completed', 'failed', 'canceled') then
    if new is distinct from old then
      if old.requested_by is not null
        and new.requested_by is null
        and (to_jsonb(new) - 'requested_by') = (to_jsonb(old) - 'requested_by') then
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

drop trigger if exists trg_guard_pipeline_job_transition on public.pipeline_jobs;
create trigger trg_guard_pipeline_job_transition
before update on public.pipeline_jobs
for each row execute function public.guard_pipeline_job_transition();

revoke execute on function public.guard_pipeline_job_transition() from public, anon, authenticated, service_role;

-- Replace the unfenced queue RPCs. Old signatures are removed so callers
-- cannot bypass claim-token checks through PostgREST overload resolution.
drop function if exists public.claim_pipeline_job(text, text, text);
drop function if exists public.complete_pipeline_job(uuid, text, text, text);

create or replace function public.claim_pipeline_job(
  p_claim_key text,
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
  requested_at timestamptz,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_claim_key text := nullif(trim(coalesce(p_claim_key, '')), '');
  fallback_app_store_id text := nullif(trim(coalesce(p_default_app_store_id, '')), '');
  fallback_country text := lower(coalesce(nullif(trim(coalesce(p_default_country, '')), ''), 'kr'));
  fallback_app_name text := nullif(trim(coalesce(p_default_app_name, '')), '');
  claimed public.pipeline_jobs;
  expired_job public.pipeline_jobs;
  prior_claim public.pipeline_job_claims;
begin
  if normalized_claim_key is null or length(normalized_claim_key) > 200 then
    raise exception using errcode = '22023', message = 'invalid claim key';
  end if;

  -- Serialize duplicate claim keys without blocking unrelated workers.
  perform pg_advisory_xact_lock(hashtextextended(normalized_claim_key, 0));

  -- Every recovery follows the same job -> run lock order as renew/persist.
  -- SKIP LOCKED prevents a boundary heartbeat from being observed as expired,
  -- and the stable order keeps concurrent claimers from choosing opposite rows.
  for expired_job in
    select pj.*
    from public.pipeline_jobs as pj
    where pj.status = 'running'
      and pj.lease_expires_at is not null
      and pj.lease_expires_at <= now()
    order by pj.id asc
    for update of pj skip locked
  loop
    if expired_job.run_id is not null then
      update public.pipeline_runs as pr
      set status = 'failed',
          validation_status = 'failed',
          validation_result = jsonb_build_object('passed', false, 'error', 'job_lease_expired'),
          updated_at = now()
      where pr.run_id = expired_job.run_id
        and pr.status <> 'published';

      delete from public.pipeline_review_ai_staging as staging
      where staging.run_id = expired_job.run_id;
    end if;

    update public.pipeline_job_claims as history
    set expired_at = coalesce(history.expired_at, now()),
        terminal_status = case when expired_job.attempt_count >= 3 then 'failed' else 'expired' end
    where history.claim_key = expired_job.claim_key
      and history.claim_token = expired_job.claim_token;

    if expired_job.attempt_count >= 3 then
      update public.pipeline_jobs as pj
      set status = 'failed',
          stage = null,
          lease_expires_at = null,
          finished_at = now(),
          error_message = 'The analysis lease expired after the maximum number of attempts.',
          updated_at = now()
      where pj.id = expired_job.id;
    elsif expired_job.attempt_count < 3 then
      update public.pipeline_jobs as pj
      set status = 'queued',
          stage = 'queued',
          run_id = null,
          claim_key = null,
          claim_token = null,
          lease_expires_at = null,
          error_message = 'The previous attempt expired and was queued again.',
          updated_at = now()
      where pj.id = expired_job.id;
    end if;
  end loop;

  -- Claim history keeps an old execution key from ever claiming another job,
  -- even after the corresponding job was requeued with a new token.
  select history.*
  into prior_claim
  from public.pipeline_job_claims as history
  where history.claim_key = normalized_claim_key;

  if found then
    select pj.* into claimed
    from public.pipeline_jobs as pj
    where pj.id = prior_claim.job_id;

    return query
    select
      claimed.id,
      claimed.app_store_id,
      claimed.country,
      claimed.app_name,
      claimed.source,
      case
        when claimed.claim_key = prior_claim.claim_key
          and claimed.claim_token = prior_claim.claim_token then claimed.status
        else coalesce(prior_claim.terminal_status, 'expired')
      end,
      claimed.requested_at,
      prior_claim.claim_token,
      case
        when claimed.claim_key = prior_claim.claim_key
          and claimed.claim_token = prior_claim.claim_token then claimed.lease_expires_at
        else prior_claim.lease_expires_at
      end,
      prior_claim.attempt_count;
    return;
  end if;

  select q.* into claimed
  from public.pipeline_jobs as q
  where q.status = 'queued'
    and q.attempt_count < 3
  order by q.requested_at asc
  limit 1
  for update skip locked;

  if claimed.id is null and fallback_app_store_id is not null then
    insert into public.pipeline_jobs (
      app_store_id, country, app_name, source, status, stage, requested_at, updated_at
    ) values (
      fallback_app_store_id, fallback_country, fallback_app_name, 'fallback', 'queued', 'queued', now(), now()
    )
    on conflict do nothing
    returning * into claimed;
  end if;

  if claimed.id is null then
    return query
    select
      null::uuid, null::text, null::text, null::text, 'queue'::text,
      'empty'::text, now(), null::uuid, null::timestamptz, 0;
    return;
  end if;

  update public.pipeline_jobs as pj
  set status = 'running',
      stage = 'fetching',
      started_at = coalesce(pj.started_at, now()),
      finished_at = null,
      claim_key = normalized_claim_key,
      claim_token = gen_random_uuid(),
      lease_expires_at = now() + interval '15 minutes',
      last_heartbeat_at = now(),
      attempt_count = pj.attempt_count + 1,
      error_message = null,
      updated_at = now()
  where pj.id = claimed.id
  returning pj.* into claimed;

  insert into public.pipeline_job_claims (
    claim_key, job_id, claim_token, attempt_count, claimed_at, lease_expires_at
  ) values (
    claimed.claim_key, claimed.id, claimed.claim_token, claimed.attempt_count, now(), claimed.lease_expires_at
  );

  return query
  select
    claimed.id,
    claimed.app_store_id,
    claimed.country,
    claimed.app_name,
    claimed.source,
    claimed.status,
    claimed.requested_at,
    claimed.claim_token,
    claimed.lease_expires_at,
    claimed.attempt_count;
end;
$$;

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
begin
  if normalized_run_id is null
    or p_stage is not null and p_stage not in ('queued', 'fetching', 'extracting', 'clustering', 'publishing') then
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

  -- A completed job may have no run at all (the no-new-review fast path), or
  -- it must point at the run already published by publish_pipeline_run in this
  -- transaction. Direct completion cannot orphan staged/upserted analysis.
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

create or replace function public.cancel_pipeline_jobs(
  p_requested_by uuid,
  p_job_id uuid default null,
  p_cancel_all boolean default false,
  p_app_store_id text default null,
  p_country text default null,
  p_reason text default 'The analysis request was canceled.'
)
returns table (job_id uuid, status text, run_id text, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  safe_reason text := case
    when p_reason = 'account_deleted' then 'The analysis request was canceled during account deletion.'
    else 'The analysis request was canceled by the user.'
  end;
begin
  if p_requested_by is null or (not coalesce(p_cancel_all, false) and p_job_id is null) then
    raise exception using errcode = '22023', message = 'invalid cancel payload';
  end if;

  perform 1
  from public.pipeline_jobs as pj
  where pj.requested_by = p_requested_by
    and pj.status in ('queued', 'running')
    and (p_job_id is null or pj.id = p_job_id)
    and (p_app_store_id is null or pj.app_store_id = p_app_store_id)
    and (p_country is null or pj.country = lower(trim(p_country)))
  order by pj.id asc
  for update;

  update public.pipeline_runs as pr
  set status = 'failed',
      validation_status = 'failed',
      validation_result = jsonb_build_object('passed', false, 'error', 'job_canceled'),
      updated_at = now()
  where pr.status <> 'published'
    and pr.run_id in (
      select pj.run_id
      from public.pipeline_jobs as pj
      where pj.requested_by = p_requested_by
        and pj.status in ('queued', 'running')
        and pj.run_id is not null
        and (p_job_id is null or pj.id = p_job_id)
        and (p_app_store_id is null or pj.app_store_id = p_app_store_id)
        and (p_country is null or pj.country = lower(trim(p_country)))
    );

  delete from public.pipeline_review_ai_staging as staging
  where staging.run_id in (
    select pj.run_id
    from public.pipeline_jobs as pj
    where pj.requested_by = p_requested_by
      and pj.status in ('queued', 'running')
      and pj.run_id is not null
      and (p_job_id is null or pj.id = p_job_id)
      and (p_app_store_id is null or pj.app_store_id = p_app_store_id)
      and (p_country is null or pj.country = lower(trim(p_country)))
  );

  update public.pipeline_job_claims as history
  set terminal_status = 'canceled'
  from public.pipeline_jobs as pj
  where pj.requested_by = p_requested_by
    and pj.status in ('queued', 'running')
    and (p_job_id is null or pj.id = p_job_id)
    and (p_app_store_id is null or pj.app_store_id = p_app_store_id)
    and (p_country is null or pj.country = lower(trim(p_country)))
    and history.claim_key = pj.claim_key
    and history.claim_token = pj.claim_token;

  return query
  update public.pipeline_jobs as pj
  set status = 'canceled',
      stage = null,
      lease_expires_at = null,
      finished_at = now(),
      error_message = safe_reason,
      updated_at = now()
  where pj.requested_by = p_requested_by
    and pj.status in ('queued', 'running')
    and (p_job_id is null or pj.id = p_job_id)
    and (p_app_store_id is null or pj.app_store_id = p_app_store_id)
    and (p_country is null or pj.country = lower(trim(p_country)))
  returning pj.id, pj.status, pj.run_id, pj.updated_at;
end;
$$;

-- A raw review from an unpublished/failed run is not "existing" until its AI
-- classification has been committed by publish_pipeline_run.
create or replace function public.get_existing_review_ids(
  p_app_store_id text,
  p_country text default 'kr',
  p_review_ids text[] default '{}'
)
returns table (review_id text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.review_id
  from public.reviews as r
  join public.review_ai as ai on ai.review_id = r.review_id
  where r.app_store_id = p_app_store_id
    and r.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
    and r.review_id = any(coalesce(p_review_ids, '{}'));
$$;

create or replace function public.persist_pipeline_reviews(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_app_store_id text,
  p_country text,
  p_app_name text,
  p_source text,
  p_reviews jsonb
)
returns table (run_id text, upserted_reviews integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
  normalized_country text := lower(coalesce(nullif(trim(p_country), ''), 'kr'));
  review_total integer := 0;
begin
  if jsonb_typeof(coalesce(p_reviews, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'reviews must be an array';
  end if;
  review_total := jsonb_array_length(coalesce(p_reviews, '[]'::jsonb));

  if exists (
    select incoming.review_id
    from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as incoming(review_id text)
    group by incoming.review_id
    having nullif(trim(coalesce(incoming.review_id, '')), '') is null or count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'review ids must be nonempty and unique';
  end if;

  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, 'clustering');
  if claim.job_id is null or claim.status <> 'running' then return; end if;

  if not exists (
    select 1 from public.pipeline_jobs pj
    where pj.id = p_job_id
      and pj.app_store_id = p_app_store_id
      and pj.country = normalized_country
  ) then
    raise exception using errcode = '23514', message = 'pipeline job scope mismatch';
  end if;

  -- review_id is globally stable. Never move an existing review to another
  -- app/country; raising rolls back the complete persistence transaction.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as incoming(review_id text)
    join public.reviews as existing on existing.review_id = incoming.review_id
    where existing.app_store_id <> p_app_store_id
       or existing.country <> normalized_country
  ) then
    raise exception using errcode = '23514', message = 'review already belongs to another app scope';
  end if;

  if exists (
    select 1 from public.pipeline_runs pr
    where pr.run_id = p_run_id
      and (pr.app_store_id <> p_app_store_id or pr.country <> normalized_country or pr.status = 'published')
  ) then
    raise exception using errcode = '23514', message = 'pipeline run scope mismatch';
  end if;

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count, executed_at, updated_at
  ) values (
    p_run_id, p_app_store_id, normalized_country, coalesce(nullif(trim(p_source), ''), 'n8n'),
    'upserted', review_total, now(), now()
  )
  on conflict on constraint pipeline_runs_run_id_key do update
  set source = excluded.source,
      status = 'upserted',
      review_count = excluded.review_count,
      updated_at = now();

  insert into public.apps (app_store_id, country, app_name, updated_at)
  values (p_app_store_id, normalized_country, null, now())
  on conflict (app_store_id, country) do nothing;

  insert into public.reviews (
    review_id, app_store_id, country, rating, author, content, reviewed_at, raw_source, updated_at
  )
  select x.review_id, p_app_store_id, normalized_country, x.rating, x.author,
    x.content, x.reviewed_at, x.raw_source, now()
  from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as x(
    review_id text, rating smallint, author text, content text, reviewed_at timestamptz,
    raw_source jsonb, priority text, category text, issue_label text, reason_summary text,
    action_hint text, summary text, confidence numeric, model_version text
  )
  on conflict (review_id) do nothing;

  -- Recheck after ON CONFLICT waits. Two apps may race with the same new
  -- review_id after both prechecks observed no row; only the winning scope may
  -- continue to staging and every losing transaction rolls back as 23514.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as incoming(review_id text)
    left join public.reviews as persisted on persisted.review_id = incoming.review_id
    where persisted.review_id is null
       or persisted.app_store_id <> p_app_store_id
       or persisted.country <> normalized_country
  ) then
    raise exception using errcode = '23514', message = 'review scope changed during persistence';
  end if;

  insert into public.pipeline_review_ai_staging (
    run_id, review_id, app_store_id, country, rating, author, content, reviewed_at,
    raw_source, priority, category, issue_label, reason_summary, action_hint,
    summary, confidence, model_version, updated_at
  )
  select p_run_id, x.review_id, p_app_store_id, normalized_country, x.rating,
    x.author, x.content, x.reviewed_at, x.raw_source, x.priority, x.category,
    x.issue_label, x.reason_summary, x.action_hint, x.summary, x.confidence,
    x.model_version, now()
  from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as x(
    review_id text, rating smallint, author text, content text, reviewed_at timestamptz,
    raw_source jsonb, priority text, category text, issue_label text, reason_summary text,
    action_hint text, summary text, confidence numeric, model_version text
  )
  on conflict on constraint pipeline_review_ai_staging_pkey do update
  set rating = excluded.rating,
      author = excluded.author,
      content = excluded.content,
      reviewed_at = excluded.reviewed_at,
      raw_source = excluded.raw_source,
      priority = excluded.priority,
      category = excluded.category,
      issue_label = excluded.issue_label,
      reason_summary = excluded.reason_summary,
      action_hint = excluded.action_hint,
      summary = excluded.summary,
      confidence = excluded.confidence,
      model_version = excluded.model_version,
      updated_at = now();

  return query select p_run_id, review_total;
end;
$$;

create or replace function public.persist_issue_clusters(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_app_store_id text,
  p_country text,
  p_model_version text,
  p_window_from timestamptz,
  p_window_to timestamptz,
  p_comparison_eligible boolean,
  p_clusters jsonb,
  p_validation_result jsonb
)
returns table (run_id text, cluster_count integer, assigned_review_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
  item jsonb;
  cluster_row public.issue_clusters;
  staged_cluster_id uuid;
  staged_first_seen timestamptz;
  staged_last_seen timestamptz;
  previous_count integer;
  review_id_value text;
  clusters_total integer := jsonb_array_length(coalesce(p_clusters, '[]'::jsonb));
  memberships_total integer := 0;
begin
  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, 'publishing');
  if claim.job_id is null or claim.status <> 'running' then return; end if;

  if clusters_total < 1
    or not exists (
      select 1 from public.pipeline_jobs pj
      where pj.id = p_job_id and pj.app_store_id = p_app_store_id
        and pj.country = lower(trim(p_country)) and pj.run_id = p_run_id
    )
    or not exists (
      select 1 from public.pipeline_runs pr
      where pr.run_id = p_run_id and pr.app_store_id = p_app_store_id
        and pr.country = lower(trim(p_country)) and pr.status = 'upserted'
    ) then
    raise exception using errcode = '23514', message = 'invalid cluster persistence scope';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_clusters) as cluster_payload(payload)
    cross join lateral jsonb_array_elements_text(cluster_payload.payload->'review_ids') as input_review(review_id)
    left join public.reviews as r
      on r.review_id = input_review.review_id
     and r.app_store_id = p_app_store_id
     and r.country = lower(trim(p_country))
    where r.review_id is null
  ) then
    raise exception using errcode = '23514', message = 'cluster review scope mismatch';
  end if;

  delete from public.issue_cluster_reviews as membership where membership.run_id = p_run_id;
  delete from public.issue_cluster_snapshots as snapshot where snapshot.run_id = p_run_id;

  for item in select value from jsonb_array_elements(p_clusters)
  loop
    select c.* into cluster_row
    from public.issue_clusters c
    where c.app_store_id = p_app_store_id
      and c.country = lower(trim(p_country))
      and c.canonical_key = item->>'canonical_key'
    for update;

    if nullif(item->>'existing_cluster_id', '') is not null
      and (cluster_row.id is null or cluster_row.id::text <> item->>'existing_cluster_id') then
      raise exception using errcode = '23514', message = 'existing cluster mismatch';
    end if;

    staged_first_seen := (item->>'first_seen_at')::timestamptz;
    staged_last_seen := (item->>'last_seen_at')::timestamptz;

    if cluster_row.id is null then
      insert into public.issue_clusters (
        app_store_id, country, canonical_key, title, category, first_seen_at,
        last_seen_at, model_version, updated_at
      ) values (
        p_app_store_id, lower(trim(p_country)), item->>'canonical_key', item->>'title',
        item->>'category', staged_first_seen, staged_last_seen, p_model_version, now()
      )
      returning * into cluster_row;
    else
      staged_first_seen := least(cluster_row.first_seen_at, staged_first_seen);
      staged_last_seen := greatest(cluster_row.last_seen_at, staged_last_seen);
    end if;

    staged_cluster_id := cluster_row.id;
    previous_count := null;
    if coalesce(p_comparison_eligible, true) and cluster_row.current_run_id is not null then
      select s.review_count into previous_count
      from public.issue_cluster_snapshots s
      where s.cluster_id = staged_cluster_id and s.run_id = cluster_row.current_run_id;
    end if;

    insert into public.issue_cluster_snapshots (
      cluster_id, run_id, title, category, first_seen_at, last_seen_at, model_version,
      severity, review_count, previous_review_count, change_percent, evidence_count,
      summary, action_hint, window_from, window_to, validation_status, validation_result, created_at
    ) values (
      staged_cluster_id,
      p_run_id,
      item->>'title',
      item->>'category',
      staged_first_seen,
      staged_last_seen,
      p_model_version,
      item->>'severity',
      jsonb_array_length(item->'review_ids'),
      previous_count,
      case when previous_count > 0 then round(
        ((jsonb_array_length(item->'review_ids') - previous_count)::numeric / previous_count::numeric) * 100,
        1
      ) else null end,
      jsonb_array_length(item->'review_ids'),
      item->>'summary',
      nullif(item->>'action_hint', ''),
      p_window_from,
      p_window_to,
      'passed',
      p_validation_result,
      now()
    );

    for review_id_value in select value #>> '{}' from jsonb_array_elements(item->'review_ids')
    loop
      insert into public.issue_cluster_reviews (run_id, review_id, cluster_id, is_representative)
      values (
        p_run_id,
        review_id_value,
        staged_cluster_id,
        coalesce(item->'representative_review_ids', '[]'::jsonb) ? review_id_value
      );
      memberships_total := memberships_total + 1;
    end loop;
  end loop;

  update public.pipeline_runs as pr
  set model_version = p_model_version,
      validation_status = 'passed',
      validation_result = p_validation_result,
      updated_at = now()
  where pr.run_id = p_run_id;

  return query select p_run_id, clusters_total, memberships_total;
end;
$$;

create or replace function public.publish_pipeline_run(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_app_store_id text,
  p_country text,
  p_published_at timestamptz default now()
)
returns table (run_id text, published_at timestamptz, cluster_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
  target_run public.pipeline_runs;
  snapshots_total integer;
begin
  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, 'publishing');
  if claim.job_id is null then return; end if;

  select pr.* into target_run
  from public.pipeline_runs pr
  where pr.run_id = p_run_id
    and pr.app_store_id = p_app_store_id
    and pr.country = lower(trim(p_country))
  for update;

  if claim.status = 'completed' then
    if target_run.status = 'published' then
      select count(*)::integer into snapshots_total
      from public.issue_cluster_snapshots s where s.run_id = p_run_id;
      return query select target_run.run_id, target_run.published_at, snapshots_total;
    end if;
    return;
  end if;

  if claim.status <> 'running'
    or target_run.run_id is null
    or target_run.status <> 'upserted'
    or target_run.validation_status <> 'passed' then
    raise exception using errcode = '23514', message = 'run is not publishable';
  end if;

  select count(*)::integer into snapshots_total
  from public.issue_cluster_snapshots s
  where s.run_id = p_run_id and s.validation_status = 'passed';
  if snapshots_total < 1 then
    raise exception using errcode = '23514', message = 'validated cluster snapshot is required';
  end if;

  if exists (
    select 1
    from public.pipeline_review_ai_staging as staging
    where staging.run_id = p_run_id
      and (staging.app_store_id <> p_app_store_id or staging.country <> lower(trim(p_country)))
  ) then
    raise exception using errcode = '23514', message = 'review staging scope mismatch';
  end if;

  -- This merge, run publication, cluster pointer update, and job completion are
  -- one transaction. Public aggregate/feed queries cannot observe staged AI.
  update public.reviews as review
  set rating = staging.rating,
      author = staging.author,
      content = staging.content,
      reviewed_at = staging.reviewed_at,
      raw_source = staging.raw_source,
      updated_at = now()
  from public.pipeline_review_ai_staging as staging
  where staging.run_id = p_run_id
    and staging.app_store_id = p_app_store_id
    and staging.country = lower(trim(p_country))
    and review.review_id = staging.review_id
    and review.app_store_id = staging.app_store_id
    and review.country = staging.country;

  insert into public.review_ai (
    review_id, priority, category, issue_label, reason_summary, action_hint,
    summary, confidence, model_version, updated_at
  )
  select staging.review_id, staging.priority, staging.category, staging.issue_label,
    staging.reason_summary, staging.action_hint, staging.summary, staging.confidence,
    staging.model_version, now()
  from public.pipeline_review_ai_staging as staging
  where staging.run_id = p_run_id
    and staging.app_store_id = p_app_store_id
    and staging.country = lower(trim(p_country))
  on conflict (review_id) do update
  set priority = excluded.priority,
      category = excluded.category,
      issue_label = excluded.issue_label,
      reason_summary = excluded.reason_summary,
      action_hint = excluded.action_hint,
      summary = excluded.summary,
      confidence = excluded.confidence,
      model_version = excluded.model_version,
      updated_at = now();

  update public.apps as app
  set app_name = coalesce(nullif(trim(job.app_name), ''), app.app_name),
      updated_at = now()
  from public.pipeline_jobs as job
  where job.id = p_job_id
    and app.app_store_id = p_app_store_id
    and app.country = lower(trim(p_country));

  update public.pipeline_runs as pr
  set status = 'published', published_at = coalesce(p_published_at, now()), updated_at = now()
  where pr.run_id = p_run_id
  returning pr.* into target_run;

  update public.issue_clusters as c
  set title = s.title,
      category = s.category,
      first_seen_at = s.first_seen_at,
      last_seen_at = s.last_seen_at,
      model_version = s.model_version,
      current_run_id = s.run_id,
      updated_at = now()
  from public.issue_cluster_snapshots as s
  where s.run_id = p_run_id and s.cluster_id = c.id and s.validation_status = 'passed';

  delete from public.pipeline_review_ai_staging as staging
  where staging.run_id = p_run_id;

  perform 1
  from public.complete_pipeline_job(
    p_job_id, p_claim_token, 'completed', null, p_run_id, null
  );
  if not found then
    raise exception using errcode = '40001', message = 'pipeline claim lost during publish';
  end if;

  return query select target_run.run_id, target_run.published_at, snapshots_total;
end;
$$;

create or replace function public.persist_pipeline_alerts(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_app_store_id text,
  p_country text,
  p_alerts jsonb
)
returns table (inserted integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
  alert_total integer := jsonb_array_length(coalesce(p_alerts, '[]'::jsonb));
begin
  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, null);
  if claim.job_id is null or claim.status <> 'running' then return; end if;

  if not exists (
    select 1 from public.pipeline_jobs pj where pj.id = p_job_id
      and pj.app_store_id = p_app_store_id and pj.country = lower(trim(p_country))
  ) then
    raise exception using errcode = '23514', message = 'pipeline alert scope mismatch';
  end if;

  insert into public.alert_events (
    event_id, run_id, review_id, app_store_id, country, rating, priority, category, summary, sent_at
  )
  select x.event_id, p_run_id, x.review_id, p_app_store_id, lower(trim(p_country)),
    x.rating, x.priority, x.category, x.summary, x.sent_at
  from jsonb_to_recordset(coalesce(p_alerts, '[]'::jsonb)) as x(
    event_id text, review_id text, rating smallint, priority text, category text,
    summary text, sent_at timestamptz
  )
  on conflict (event_id) do update
  set run_id = excluded.run_id,
      rating = excluded.rating,
      priority = excluded.priority,
      category = excluded.category,
      summary = excluded.summary,
      sent_at = excluded.sent_at;

  return query select alert_total;
end;
$$;

create or replace function public.record_pipeline_parse_error(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_parse_error_id text,
  p_app_store_id text,
  p_country text,
  p_message text,
  p_raw_response text
)
returns table (parse_error_id text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
begin
  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, null);
  if claim.job_id is null then return; end if;

  if claim.status = 'failed' then
    if exists (select 1 from public.parse_errors pe where pe.parse_error_id = p_parse_error_id) then
      return query select p_parse_error_id;
    end if;
    return;
  end if;
  if claim.status <> 'running' then return; end if;

  insert into public.parse_errors (
    parse_error_id, run_id, app_store_id, country, message, raw_response, created_at
  ) values (
    p_parse_error_id, p_run_id, nullif(trim(coalesce(p_app_store_id, '')), ''),
    nullif(lower(trim(coalesce(p_country, ''))), ''), left(coalesce(p_message, ''), 1000),
    left(coalesce(p_raw_response, ''), 8000), now()
  )
  on conflict on constraint parse_errors_parse_error_id_key do update
  set message = excluded.message, raw_response = excluded.raw_response;

  perform 1
  from public.complete_pipeline_job(
    p_job_id, p_claim_token, 'failed', null, p_run_id,
    'The analysis output could not be processed. Retry the request.'
  );
  if not found then
    raise exception using errcode = '40001', message = 'pipeline claim lost during parse error persistence';
  end if;

  return query select p_parse_error_id;
end;
$$;

create or replace function public.get_pipeline_cluster_context(
  p_app_store_id text,
  p_country text default 'kr'
)
returns table (
  issue_id uuid,
  canonical_key text,
  title text,
  category text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  review_count integer,
  run_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with latest_run as (
    select pr.run_id
    from public.pipeline_runs pr
    where pr.app_store_id = p_app_store_id
      and pr.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
      and pr.status = 'published'
      and pr.validation_status = 'passed'
    order by pr.published_at desc nulls last, pr.updated_at desc
    limit 1
  )
  select c.id, c.canonical_key, s.title, s.category, s.first_seen_at,
    s.last_seen_at, s.review_count, s.run_id
  from latest_run
  join public.issue_cluster_snapshots s on s.run_id = latest_run.run_id
    and s.validation_status = 'passed'
  join public.issue_clusters c on c.id = s.cluster_id
  order by s.review_count desc, c.canonical_key
  limit 100;
$$;

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
set search_path = pg_catalog, public
as $$
  with latest_run as (
    select pr.run_id, pr.published_at, pr.updated_at
    from public.pipeline_runs pr
    where pr.app_store_id = p_app_store_id
      and pr.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
      and pr.status = 'published'
      and pr.validation_status = 'passed'
    order by pr.published_at desc nulls last, pr.updated_at desc
    limit 1
  )
  select c.id, s.title, s.category, s.severity, s.review_count,
    s.change_percent, s.evidence_count, s.last_seen_at, s.summary,
    s.action_hint, s.run_id, s.model_version,
    coalesce(latest_run.published_at, latest_run.updated_at, s.created_at)
  from latest_run
  join public.issue_cluster_snapshots s
    on s.run_id = latest_run.run_id and s.validation_status = 'passed'
  join public.issue_clusters c on c.id = s.cluster_id
  order by case s.severity when 'high' then 1 when 'medium' then 2 else 3 end,
    s.review_count desc, s.last_seen_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

create or replace function public.get_public_issue_detail(p_issue_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with target_cluster as (
    select c.* from public.issue_clusters c where c.id = p_issue_id
  ), latest_run as (
    select pr.run_id, pr.published_at, pr.updated_at
    from public.pipeline_runs pr
    join target_cluster c on c.app_store_id = pr.app_store_id and c.country = pr.country
    where pr.status = 'published' and pr.validation_status = 'passed'
    order by pr.published_at desc nulls last, pr.updated_at desc
    limit 1
  )
  select jsonb_build_object(
    'issue', jsonb_build_object(
      'issueId', c.id, 'appStoreId', c.app_store_id, 'country', c.country,
      'title', s.title, 'category', s.category, 'severity', s.severity,
      'reviewCount', s.review_count, 'changePercent', s.change_percent,
      'evidenceCount', s.evidence_count, 'lastOccurredAt', s.last_seen_at,
      'summary', s.summary, 'actionHint', s.action_hint, 'runId', s.run_id,
      'modelVersion', s.model_version, 'validation', s.validation_result,
      'analyzedAt', coalesce(latest_run.published_at, latest_run.updated_at, s.created_at)
    ),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reviewId', r.review_id, 'rating', r.rating, 'author', r.author,
        'content', r.content, 'reviewedAt', r.reviewed_at, 'summary', ai.summary,
        'isRepresentative', cr.is_representative
      ) order by cr.is_representative desc, r.reviewed_at desc, r.review_id desc)
      from public.issue_cluster_reviews cr
      join public.reviews r on r.review_id = cr.review_id
      left join public.review_ai ai on ai.review_id = r.review_id
      where cr.cluster_id = c.id and cr.run_id = s.run_id
    ), '[]'::jsonb)
  )
  from target_cluster c
  join latest_run on true
  join public.issue_cluster_snapshots s
    on s.cluster_id = c.id and s.run_id = latest_run.run_id
    and s.validation_status = 'passed';
$$;

-- SECURITY DEFINER pipeline RPCs are callable only by the service-role Worker.
revoke execute on function public.get_existing_review_ids(text, text, text[]) from public, anon, authenticated;
revoke execute on function public.claim_pipeline_job(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.renew_pipeline_job_claim(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.complete_pipeline_job(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.cancel_pipeline_jobs(uuid, uuid, boolean, text, text, text) from public, anon, authenticated;
revoke execute on function public.persist_pipeline_reviews(uuid, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.persist_issue_clusters(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.publish_pipeline_run(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.persist_pipeline_alerts(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.record_pipeline_parse_error(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_pipeline_cluster_context(text, text) from public, anon, authenticated;

grant execute on function public.get_existing_review_ids(text, text, text[]) to service_role;
grant execute on function public.claim_pipeline_job(text, text, text, text) to service_role;
grant execute on function public.renew_pipeline_job_claim(uuid, uuid, text, text) to service_role;
grant execute on function public.complete_pipeline_job(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.cancel_pipeline_jobs(uuid, uuid, boolean, text, text, text) to service_role;
grant execute on function public.persist_pipeline_reviews(uuid, uuid, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.persist_issue_clusters(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb) to service_role;
grant execute on function public.publish_pipeline_run(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.persist_pipeline_alerts(uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.record_pipeline_parse_error(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.get_pipeline_cluster_context(text, text) to service_role;

revoke all on function public.get_public_issue_clusters(text, text, integer) from public;
revoke all on function public.get_public_issue_detail(uuid) from public;
grant execute on function public.get_public_issue_clusters(text, text, integer) to anon, authenticated;
grant execute on function public.get_public_issue_detail(uuid) to anon, authenticated;

-- Scope issue counts and evidence to the same review window used by the
-- overview, category, trend, and review-feed reads. Each review contributes
-- only its latest membership from a published, validated run.

create or replace function public.get_public_issue_clusters_windowed(
  p_app_store_id text,
  p_country text default 'kr',
  p_limit integer default 50,
  p_from timestamptz default null,
  p_to timestamptz default null
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
  analyzed_at timestamptz,
  total_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with utc_clock as (
    select date_trunc('day', current_timestamp at time zone 'UTC') at time zone 'UTC' as utc_today
  ), bounds as (
    select coalesce(p_from, utc_today - interval '29 days') as from_at,
      coalesce(p_to, utc_today + interval '1 day' - interval '1 millisecond') as to_at
    from utc_clock
    where ((p_from is null and p_to is null) or (p_from is not null and p_to is not null))
      and coalesce(p_to, utc_today + interval '1 day' - interval '1 millisecond')
        >= coalesce(p_from, utc_today - interval '29 days')
      and coalesce(p_to, utc_today + interval '1 day' - interval '1 millisecond')
        - coalesce(p_from, utc_today - interval '29 days') <= interval '90 days'
  ), scoped_memberships as (
    select cr.review_id, cr.cluster_id, r.reviewed_at,
      row_number() over (
        partition by cr.review_id
        order by pr.published_at desc nulls last, pr.updated_at desc, pr.run_id desc
      ) as membership_rank
    from bounds
    cross join public.issue_cluster_reviews cr
    join public.issue_clusters c on c.id = cr.cluster_id
    join public.issue_cluster_snapshots membership_snapshot
      on membership_snapshot.cluster_id = cr.cluster_id
      and membership_snapshot.run_id = cr.run_id
      and membership_snapshot.validation_status = 'passed'
    join public.pipeline_runs pr
      on pr.run_id = cr.run_id
      and pr.app_store_id = c.app_store_id
      and pr.country = c.country
      and pr.status = 'published'
      and pr.validation_status = 'passed'
    join public.reviews r on r.review_id = cr.review_id
    where c.app_store_id = p_app_store_id
      and c.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
      and r.app_store_id = c.app_store_id
      and r.country = c.country
      and r.reviewed_at >= bounds.from_at
      and r.reviewed_at <= bounds.to_at
  ), current_memberships as (
    select membership.cluster_id, membership.reviewed_at
    from scoped_memberships membership
    where membership.membership_rank = 1
  ), evidence as (
    select membership.cluster_id, count(*)::integer as review_count,
      max(membership.reviewed_at) as last_occurred_at
    from current_memberships membership
    group by membership.cluster_id
  ), ranked_snapshots as (
    select s.cluster_id, s.title, s.category, s.severity, s.change_percent,
      s.summary, s.action_hint, s.run_id, s.model_version,
      coalesce(pr.published_at, pr.updated_at, s.created_at) as analyzed_at,
      row_number() over (
        partition by s.cluster_id
        order by pr.published_at desc nulls last, pr.updated_at desc, pr.run_id desc
      ) as snapshot_rank
    from public.issue_cluster_snapshots s
    join public.issue_clusters c on c.id = s.cluster_id
    join public.pipeline_runs pr
      on pr.run_id = s.run_id
      and pr.app_store_id = c.app_store_id
      and pr.country = c.country
      and pr.status = 'published'
      and pr.validation_status = 'passed'
    where s.validation_status = 'passed'
      and c.app_store_id = p_app_store_id
      and c.country = lower(coalesce(nullif(trim(p_country), ''), 'kr'))
  )
  select s.cluster_id, s.title, s.category, s.severity, evidence.review_count,
    case when p_from is null and p_to is null then s.change_percent else null::numeric end,
    evidence.review_count, evidence.last_occurred_at, s.summary, s.action_hint,
    s.run_id, s.model_version, s.analyzed_at, count(*) over()::integer
  from evidence
  join ranked_snapshots s
    on s.cluster_id = evidence.cluster_id and s.snapshot_rank = 1
  order by case s.severity when 'high' then 1 when 'medium' then 2 else 3 end,
    evidence.review_count desc, evidence.last_occurred_at desc, s.cluster_id
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

create or replace function public.get_public_issue_detail_windowed(
  p_issue_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with utc_clock as (
    select date_trunc('day', current_timestamp at time zone 'UTC') at time zone 'UTC' as utc_today
  ), bounds as (
    select coalesce(p_from, utc_today - interval '29 days') as from_at,
      coalesce(p_to, utc_today + interval '1 day' - interval '1 millisecond') as to_at
    from utc_clock
    where ((p_from is null and p_to is null) or (p_from is not null and p_to is not null))
      and coalesce(p_to, utc_today + interval '1 day' - interval '1 millisecond')
        >= coalesce(p_from, utc_today - interval '29 days')
      and coalesce(p_to, utc_today + interval '1 day' - interval '1 millisecond')
        - coalesce(p_from, utc_today - interval '29 days') <= interval '90 days'
  ), target_cluster as (
    select c.* from public.issue_clusters c where c.id = p_issue_id
  ), ranked_snapshots as (
    select c.id, c.app_store_id, c.country, s.title, s.category, s.severity,
      s.change_percent, s.summary, s.action_hint, s.run_id, s.model_version,
      s.validation_result,
      coalesce(pr.published_at, pr.updated_at, s.created_at) as analyzed_at,
      row_number() over (
        order by pr.published_at desc nulls last, pr.updated_at desc, pr.run_id desc
      ) as snapshot_rank
    from target_cluster c
    join public.issue_cluster_snapshots s
      on s.cluster_id = c.id and s.validation_status = 'passed'
    join public.pipeline_runs pr
      on pr.run_id = s.run_id
      and pr.app_store_id = c.app_store_id
      and pr.country = c.country
      and pr.status = 'published'
      and pr.validation_status = 'passed'
  ), target_snapshot as (
    select * from ranked_snapshots where snapshot_rank = 1
  ), scoped_memberships as (
    select cr.review_id, cr.cluster_id, cr.is_representative, r.rating, r.author,
      r.content, r.reviewed_at,
      row_number() over (
        partition by cr.review_id
        order by pr.published_at desc nulls last, pr.updated_at desc, pr.run_id desc
      ) as membership_rank
    from bounds
    cross join target_cluster target
    join public.issue_clusters c
      on c.app_store_id = target.app_store_id and c.country = target.country
    join public.issue_cluster_reviews cr on cr.cluster_id = c.id
    join public.issue_cluster_snapshots membership_snapshot
      on membership_snapshot.cluster_id = cr.cluster_id
      and membership_snapshot.run_id = cr.run_id
      and membership_snapshot.validation_status = 'passed'
    join public.pipeline_runs pr
      on pr.run_id = cr.run_id
      and pr.app_store_id = c.app_store_id
      and pr.country = c.country
      and pr.status = 'published'
      and pr.validation_status = 'passed'
    join public.reviews r on r.review_id = cr.review_id
    where r.app_store_id = target.app_store_id
      and r.country = target.country
      and r.reviewed_at >= bounds.from_at
      and r.reviewed_at <= bounds.to_at
  ), windowed_reviews as (
    select membership.review_id, membership.rating, membership.author,
      membership.content, membership.reviewed_at, ai.summary,
      membership.is_representative
    from scoped_memberships membership
    left join public.review_ai ai on ai.review_id = membership.review_id
    where membership.membership_rank = 1
      and membership.cluster_id = p_issue_id
  ), evidence as (
    select count(*)::integer as review_count, max(reviewed_at) as last_occurred_at
    from windowed_reviews
  ), bounded_reviews as (
    select review.*
    from windowed_reviews review
    order by review.is_representative desc, review.reviewed_at desc, review.review_id desc
    limit 50
  )
  select jsonb_build_object(
    'issue', jsonb_build_object(
      'issueId', target.id, 'appStoreId', target.app_store_id, 'country', target.country,
      'title', target.title, 'category', target.category, 'severity', target.severity,
      'reviewCount', evidence.review_count,
      'changePercent', case
        when p_from is null and p_to is null then target.change_percent else null::numeric
      end,
      'evidenceCount', evidence.review_count, 'lastOccurredAt', evidence.last_occurred_at,
      'summary', target.summary, 'actionHint', target.action_hint, 'runId', target.run_id,
      'modelVersion', target.model_version, 'validation', target.validation_result,
      'analyzedAt', target.analyzed_at
    ),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reviewId', review.review_id, 'rating', review.rating, 'author', review.author,
        'content', review.content, 'reviewedAt', review.reviewed_at,
        'summary', review.summary, 'isRepresentative', review.is_representative
      ) order by review.is_representative desc, review.reviewed_at desc, review.review_id desc)
      from bounded_reviews review
    ), '[]'::jsonb)
  )
  from target_snapshot target
  cross join evidence
  where evidence.review_count > 0;
$$;

revoke all on function public.get_public_issue_clusters_windowed(text, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.get_public_issue_detail_windowed(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_public_issue_clusters_windowed(text, text, integer, timestamptz, timestamptz)
  to service_role;
grant execute on function public.get_public_issue_detail_windowed(uuid, timestamptz, timestamptz)
  to service_role;

-- Keep the latest-run overloads service-role-only for Worker rollback while
-- the windowed read path is promoted behind REPORT_V2_ENABLED.
revoke all on function public.get_public_issue_clusters(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.get_public_issue_detail(uuid)
  from public, anon, authenticated;
grant execute on function public.get_public_issue_clusters(text, text, integer)
  to service_role;
grant execute on function public.get_public_issue_detail(uuid)
  to service_role;

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

-- Resolve up to the pipeline input cap in one service-role RPC. Returning one
-- JSON value avoids PostgREST row limits without putting review IDs in a URL.

create or replace function public.get_pipeline_review_scope(
  p_app_store_id text,
  p_country text default 'kr',
  p_review_ids text[] default '{}',
  p_include_analysis boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_country text := lower(coalesce(nullif(trim(p_country), ''), 'kr'));
  requested_count integer := coalesce(cardinality(p_review_ids), 0);
  result jsonb;
begin
  if nullif(trim(coalesce(p_app_store_id, '')), '') is null
    or requested_count = 0
    or requested_count > 10000 then
    raise exception using errcode = '22023', message = 'invalid pipeline review scope lookup';
  end if;

  if exists (
    select 1
    from unnest(p_review_ids) as requested(review_id)
    where nullif(trim(coalesce(requested.review_id, '')), '') is null
      or requested.review_id <> trim(requested.review_id)
  ) or requested_count <> (
    select count(distinct requested.review_id)
    from unnest(p_review_ids) as requested(review_id)
  ) then
    raise exception using errcode = '23514', message = 'review ids must be nonempty, trimmed, and unique';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'review_id', review.review_id,
        'app_store_id', review.app_store_id,
        'country', review.country,
        'reviewed_at', review.reviewed_at,
        'priority', case when p_include_analysis then analysis.priority end,
        'category', case when p_include_analysis then analysis.category end,
        'summary', case when p_include_analysis then analysis.summary end
      ))
      order by requested.ordinality
    ),
    '[]'::jsonb
  ) into result
  from unnest(p_review_ids) with ordinality as requested(review_id, ordinality)
  join public.reviews as review
    on review.review_id = requested.review_id
   and review.app_store_id = p_app_store_id
   and review.country = normalized_country
  left join public.review_ai as analysis
    on analysis.review_id = review.review_id
  where not p_include_analysis or analysis.review_id is not null;

  return result;
end;
$$;

revoke execute on function public.get_pipeline_review_scope(text, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.get_pipeline_review_scope(text, text, text[], boolean)
  to service_role;

-- Return each cluster's latest valid published identity as one bounded JSON
-- value so incremental runs do not hide untouched historical identities.

create or replace function public.get_pipeline_cluster_context_v2(
  p_app_store_id text,
  p_country text default 'kr'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_country text := lower(coalesce(nullif(trim(p_country), ''), 'kr'));
  context_count integer;
  result jsonb;
begin
  if nullif(trim(coalesce(p_app_store_id, '')), '') is null then
    raise exception using errcode = '22023', message = 'invalid pipeline cluster context scope';
  end if;

  with ranked_context as (
    select
      snapshot.cluster_id,
      row_number() over (
        partition by snapshot.cluster_id
        order by pipeline_run.published_at desc nulls last,
          pipeline_run.updated_at desc, snapshot.created_at desc, snapshot.run_id desc
      ) as recency_rank
    from public.issue_cluster_snapshots as snapshot
    join public.issue_clusters as cluster on cluster.id = snapshot.cluster_id
    join public.pipeline_runs as pipeline_run
      on pipeline_run.run_id = snapshot.run_id
      and pipeline_run.app_store_id = cluster.app_store_id
      and pipeline_run.country = cluster.country
    where cluster.app_store_id = p_app_store_id
      and cluster.country = normalized_country
      and pipeline_run.status = 'published'
      and pipeline_run.validation_status = 'passed'
      and snapshot.validation_status = 'passed'
  )
  select count(*) into context_count
  from ranked_context
  where recency_rank = 1;

  if context_count > 10000 then
    raise exception using errcode = '54000', message = 'pipeline cluster context exceeds the input contract';
  end if;

  with ranked_context as (
    select
      cluster.id as issue_id,
      cluster.canonical_key,
      snapshot.title,
      snapshot.category,
      left(snapshot.summary, 400) as summary,
      snapshot.first_seen_at,
      snapshot.last_seen_at,
      snapshot.review_count,
      snapshot.run_id,
      row_number() over (
        partition by snapshot.cluster_id
        order by pipeline_run.published_at desc nulls last,
          pipeline_run.updated_at desc, snapshot.created_at desc, snapshot.run_id desc
      ) as recency_rank
    from public.issue_cluster_snapshots as snapshot
    join public.issue_clusters as cluster on cluster.id = snapshot.cluster_id
    join public.pipeline_runs as pipeline_run
      on pipeline_run.run_id = snapshot.run_id
      and pipeline_run.app_store_id = cluster.app_store_id
      and pipeline_run.country = cluster.country
    where cluster.app_store_id = p_app_store_id
      and cluster.country = normalized_country
      and pipeline_run.status = 'published'
      and pipeline_run.validation_status = 'passed'
      and snapshot.validation_status = 'passed'
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'issue_id', context.issue_id,
        'canonical_key', context.canonical_key,
        'title', context.title,
        'category', context.category,
        'summary', context.summary,
        'first_seen_at', context.first_seen_at,
        'last_seen_at', context.last_seen_at,
        'review_count', context.review_count,
        'run_id', context.run_id
      )
      order by context.category, context.review_count desc,
        context.last_seen_at desc, context.canonical_key
    ),
    '[]'::jsonb
  ) into result
  from ranked_context as context
  where context.recency_rank = 1;

  return result;
end;
$$;

revoke execute on function public.get_pipeline_cluster_context_v2(text, text)
  from public, anon, authenticated;
grant execute on function public.get_pipeline_cluster_context_v2(text, text)
  to service_role;

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

-- Reject empty or oversized signed persistence payloads before claim renewal.

create or replace function public.persist_pipeline_reviews(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_app_store_id text,
  p_country text,
  p_app_name text,
  p_source text,
  p_reviews jsonb
)
returns table (run_id text, upserted_reviews integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
  normalized_country text := lower(coalesce(nullif(trim(p_country), ''), 'kr'));
  review_total integer := 0;
begin
  if jsonb_typeof(coalesce(p_reviews, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'reviews must be an array';
  end if;
  review_total := jsonb_array_length(coalesce(p_reviews, '[]'::jsonb));
  if review_total < 1 or review_total > 10000 then
    raise exception using errcode = '22023', message = 'review count must be between 1 and 10000';
  end if;

  if exists (
    select incoming.review_id
    from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as incoming(review_id text)
    group by incoming.review_id
    having nullif(trim(coalesce(incoming.review_id, '')), '') is null or count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'review ids must be nonempty and unique';
  end if;

  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, 'clustering');
  if claim.job_id is null or claim.status <> 'running' then return; end if;

  if not exists (
    select 1 from public.pipeline_jobs pj
    where pj.id = p_job_id
      and pj.app_store_id = p_app_store_id
      and pj.country = normalized_country
  ) then
    raise exception using errcode = '23514', message = 'pipeline job scope mismatch';
  end if;

  -- review_id is globally stable. Never move an existing review to another
  -- app/country; raising rolls back the complete persistence transaction.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as incoming(review_id text)
    join public.reviews as existing on existing.review_id = incoming.review_id
    where existing.app_store_id <> p_app_store_id
       or existing.country <> normalized_country
  ) then
    raise exception using errcode = '23514', message = 'review already belongs to another app scope';
  end if;

  if exists (
    select 1 from public.pipeline_runs pr
    where pr.run_id = p_run_id
      and (pr.app_store_id <> p_app_store_id or pr.country <> normalized_country or pr.status = 'published')
  ) then
    raise exception using errcode = '23514', message = 'pipeline run scope mismatch';
  end if;

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count, executed_at, updated_at
  ) values (
    p_run_id, p_app_store_id, normalized_country, coalesce(nullif(trim(p_source), ''), 'n8n'),
    'upserted', review_total, now(), now()
  )
  on conflict on constraint pipeline_runs_run_id_key do update
  set source = excluded.source,
      status = 'upserted',
      review_count = excluded.review_count,
      updated_at = now();

  insert into public.apps (app_store_id, country, app_name, updated_at)
  values (p_app_store_id, normalized_country, null, now())
  on conflict (app_store_id, country) do nothing;

  insert into public.reviews (
    review_id, app_store_id, country, rating, author, content, reviewed_at, raw_source, updated_at
  )
  select x.review_id, p_app_store_id, normalized_country, x.rating, x.author,
    x.content, x.reviewed_at, x.raw_source, now()
  from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as x(
    review_id text, rating smallint, author text, content text, reviewed_at timestamptz,
    raw_source jsonb, priority text, category text, issue_label text, reason_summary text,
    action_hint text, summary text, confidence numeric, model_version text
  )
  on conflict (review_id) do nothing;

  -- Recheck after ON CONFLICT waits. Two apps may race with the same new
  -- review_id after both prechecks observed no row; only the winning scope may
  -- continue to staging and every losing transaction rolls back as 23514.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as incoming(review_id text)
    left join public.reviews as persisted on persisted.review_id = incoming.review_id
    where persisted.review_id is null
       or persisted.app_store_id <> p_app_store_id
       or persisted.country <> normalized_country
  ) then
    raise exception using errcode = '23514', message = 'review scope changed during persistence';
  end if;

  insert into public.pipeline_review_ai_staging (
    run_id, review_id, app_store_id, country, rating, author, content, reviewed_at,
    raw_source, priority, category, issue_label, reason_summary, action_hint,
    summary, confidence, model_version, updated_at
  )
  select p_run_id, x.review_id, p_app_store_id, normalized_country, x.rating,
    x.author, x.content, x.reviewed_at, x.raw_source, x.priority, x.category,
    x.issue_label, x.reason_summary, x.action_hint, x.summary, x.confidence,
    x.model_version, now()
  from jsonb_to_recordset(coalesce(p_reviews, '[]'::jsonb)) as x(
    review_id text, rating smallint, author text, content text, reviewed_at timestamptz,
    raw_source jsonb, priority text, category text, issue_label text, reason_summary text,
    action_hint text, summary text, confidence numeric, model_version text
  )
  on conflict on constraint pipeline_review_ai_staging_pkey do update
  set rating = excluded.rating,
      author = excluded.author,
      content = excluded.content,
      reviewed_at = excluded.reviewed_at,
      raw_source = excluded.raw_source,
      priority = excluded.priority,
      category = excluded.category,
      issue_label = excluded.issue_label,
      reason_summary = excluded.reason_summary,
      action_hint = excluded.action_hint,
      summary = excluded.summary,
      confidence = excluded.confidence,
      model_version = excluded.model_version,
      updated_at = now();

  return query select p_run_id, review_total;
end;
$$;

revoke execute on function public.persist_pipeline_reviews(uuid, uuid, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_pipeline_reviews(uuid, uuid, text, text, text, text, text, jsonb)
  to service_role;

create or replace function public.persist_issue_clusters(
  p_job_id uuid,
  p_claim_token uuid,
  p_run_id text,
  p_app_store_id text,
  p_country text,
  p_model_version text,
  p_window_from timestamptz,
  p_window_to timestamptz,
  p_comparison_eligible boolean,
  p_clusters jsonb,
  p_validation_result jsonb
)
returns table (run_id text, cluster_count integer, assigned_review_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claim record;
  item jsonb;
  cluster_row public.issue_clusters;
  staged_cluster_id uuid;
  staged_first_seen timestamptz;
  staged_last_seen timestamptz;
  previous_count integer;
  review_id_value text;
  clusters_total integer := 0;
  input_memberships_total bigint := 0;
  memberships_total integer := 0;
begin
  if jsonb_typeof(coalesce(p_clusters, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'clusters must be an array';
  end if;
  clusters_total := jsonb_array_length(coalesce(p_clusters, '[]'::jsonb));

  if exists (
    select 1
    from jsonb_array_elements(p_clusters) as cluster_payload(payload)
    where jsonb_typeof(cluster_payload.payload) is distinct from 'object'
      or jsonb_typeof(cluster_payload.payload->'review_ids') is distinct from 'array'
  ) then
    raise exception using errcode = '22023', message = 'cluster memberships must be arrays';
  end if;

  select coalesce(sum(jsonb_array_length(cluster_payload.payload->'review_ids')), 0)
    into input_memberships_total
  from jsonb_array_elements(p_clusters) as cluster_payload(payload);

  if clusters_total < 1 or clusters_total > 10000
    or input_memberships_total < 1 or input_memberships_total > 10000 then
    raise exception using errcode = '22023', message = 'cluster and membership counts must be between 1 and 10000';
  end if;

  select * into claim
  from public.renew_pipeline_job_claim(p_job_id, p_claim_token, p_run_id, 'publishing');
  if claim.job_id is null or claim.status <> 'running' then return; end if;

  if not exists (
      select 1 from public.pipeline_jobs pj
      where pj.id = p_job_id and pj.app_store_id = p_app_store_id
        and pj.country = lower(trim(p_country)) and pj.run_id = p_run_id
    )
    or not exists (
      select 1 from public.pipeline_runs pr
      where pr.run_id = p_run_id and pr.app_store_id = p_app_store_id
        and pr.country = lower(trim(p_country)) and pr.status = 'upserted'
    ) then
    raise exception using errcode = '23514', message = 'invalid cluster persistence scope';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_clusters) as cluster_payload(payload)
    cross join lateral jsonb_array_elements_text(cluster_payload.payload->'review_ids') as input_review(review_id)
    left join public.reviews as r
      on r.review_id = input_review.review_id
     and r.app_store_id = p_app_store_id
     and r.country = lower(trim(p_country))
    where r.review_id is null
  ) then
    raise exception using errcode = '23514', message = 'cluster review scope mismatch';
  end if;

  delete from public.issue_cluster_reviews as membership where membership.run_id = p_run_id;
  delete from public.issue_cluster_snapshots as snapshot where snapshot.run_id = p_run_id;

  for item in select value from jsonb_array_elements(p_clusters)
  loop
    select c.* into cluster_row
    from public.issue_clusters c
    where c.app_store_id = p_app_store_id
      and c.country = lower(trim(p_country))
      and c.canonical_key = item->>'canonical_key'
    for update;

    if nullif(item->>'existing_cluster_id', '') is not null
      and (cluster_row.id is null or cluster_row.id::text <> item->>'existing_cluster_id') then
      raise exception using errcode = '23514', message = 'existing cluster mismatch';
    end if;

    staged_first_seen := (item->>'first_seen_at')::timestamptz;
    staged_last_seen := (item->>'last_seen_at')::timestamptz;

    if cluster_row.id is null then
      insert into public.issue_clusters (
        app_store_id, country, canonical_key, title, category, first_seen_at,
        last_seen_at, model_version, updated_at
      ) values (
        p_app_store_id, lower(trim(p_country)), item->>'canonical_key', item->>'title',
        item->>'category', staged_first_seen, staged_last_seen, p_model_version, now()
      )
      returning * into cluster_row;
    else
      staged_first_seen := least(cluster_row.first_seen_at, staged_first_seen);
      staged_last_seen := greatest(cluster_row.last_seen_at, staged_last_seen);
    end if;

    staged_cluster_id := cluster_row.id;
    previous_count := null;
    if coalesce(p_comparison_eligible, true) and cluster_row.current_run_id is not null then
      select s.review_count into previous_count
      from public.issue_cluster_snapshots s
      where s.cluster_id = staged_cluster_id and s.run_id = cluster_row.current_run_id;
    end if;

    insert into public.issue_cluster_snapshots (
      cluster_id, run_id, title, category, first_seen_at, last_seen_at, model_version,
      severity, review_count, previous_review_count, change_percent, evidence_count,
      summary, action_hint, window_from, window_to, validation_status, validation_result, created_at
    ) values (
      staged_cluster_id,
      p_run_id,
      item->>'title',
      item->>'category',
      staged_first_seen,
      staged_last_seen,
      p_model_version,
      item->>'severity',
      jsonb_array_length(item->'review_ids'),
      previous_count,
      case when previous_count > 0 then round(
        ((jsonb_array_length(item->'review_ids') - previous_count)::numeric / previous_count::numeric) * 100,
        1
      ) else null end,
      jsonb_array_length(item->'review_ids'),
      item->>'summary',
      nullif(item->>'action_hint', ''),
      p_window_from,
      p_window_to,
      'passed',
      p_validation_result,
      now()
    );

    for review_id_value in select value #>> '{}' from jsonb_array_elements(item->'review_ids')
    loop
      insert into public.issue_cluster_reviews (run_id, review_id, cluster_id, is_representative)
      values (
        p_run_id,
        review_id_value,
        staged_cluster_id,
        coalesce(item->'representative_review_ids', '[]'::jsonb) ? review_id_value
      );
      memberships_total := memberships_total + 1;
    end loop;
  end loop;

  update public.pipeline_runs as pr
  set model_version = p_model_version,
      validation_status = 'passed',
      validation_result = p_validation_result,
      updated_at = now()
  where pr.run_id = p_run_id;

  return query select p_run_id, clusters_total, memberships_total;
end;
$$;

revoke execute on function public.persist_issue_clusters(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_issue_clusters(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb)
  to service_role;

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
