create extension if not exists pgcrypto;

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
  priority text not null check (priority in ('Critical', 'High', 'Normal', '🚨 Critical', '⚠️ High', '✅ Normal')),
  category text not null,
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

create index if not exists idx_reviews_app_country_reviewed_at on public.reviews(app_store_id, country, reviewed_at desc);
create index if not exists idx_reviews_rating on public.reviews(rating);
create index if not exists idx_review_ai_priority on public.review_ai(priority);
create index if not exists idx_pipeline_runs_run_id on public.pipeline_runs(run_id);
create index if not exists idx_parse_errors_run_id on public.parse_errors(run_id);
create index if not exists idx_alert_events_run_id on public.alert_events(run_id);

alter table public.apps enable row level security;
alter table public.reviews enable row level security;
alter table public.review_ai enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.parse_errors enable row level security;
alter table public.alert_events enable row level security;

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

create or replace view public.private_review_feed as
select
  r.review_id,
  r.app_store_id,
  r.country,
  r.rating,
  r.author,
  r.content,
  r.reviewed_at,
  ai.priority,
  ai.category,
  ai.summary,
  ai.confidence
from public.reviews r
join public.review_ai ai using (review_id);

revoke all on table public.private_review_feed from anon;
grant select on table public.private_review_feed to authenticated;

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
    select r.review_id, r.app_store_id, r.country, r.rating, r.reviewed_at, ai.priority
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
      where lower(replace(replace(replace(priority, '🚨', ''), '⚠️', ''), '✅', '')) like '%critical%'
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
      where lower(replace(replace(replace(ai.priority, '🚨', ''), '⚠️', ''), '✅', '')) like '%critical%'
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
    select ai.category
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

grant execute on function public.get_public_overview(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_trends(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_categories(text, text, timestamptz, timestamptz) to anon, authenticated;
