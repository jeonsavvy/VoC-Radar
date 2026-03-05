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
  select coalesce(nullif(trim(coalesce(p_category, '')), ''), '긍정 리뷰 및 기타');
$$;

update public.review_ai ai
set
  category = public.normalize_review_category(ai.category, ai.summary, r.content),
  updated_at = now()
from public.reviews r
where r.review_id = ai.review_id
  and ai.category is distinct from public.normalize_review_category(ai.category, ai.summary, r.content);

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
  public.normalize_review_category(ai.category, ai.summary, r.content) as category,
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

grant execute on function public.get_public_overview(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_trends(text, text, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_public_categories(text, text, timestamptz, timestamptz) to anon, authenticated;
