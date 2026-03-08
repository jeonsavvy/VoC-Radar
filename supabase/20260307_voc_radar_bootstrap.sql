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
-- view: 인증 사용자 리뷰 피드
-- -----------------------------------------------------------------------------
drop view if exists public.private_review_feed;
create view public.private_review_feed as
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

revoke all on table public.private_review_feed from anon;
grant select on table public.private_review_feed to authenticated;

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
grant execute on function public.get_existing_review_ids(text, text, text[]) to anon, authenticated;
