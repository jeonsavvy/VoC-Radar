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
    when source ~ '(결제|구독|환불|인앱|구매|billing|payment|subscription|refund)' then '결제/구독'
    when source ~ '(로그인|log in|login|계정|인증|회원가입|가입|account|auth|sign in)' then '계정/로그인'
    when source ~ '(버그|오류|에러|튕|크래시|멈춤|작동.?안|실행.?안|bug|error|crash|fail)' then '기능오류'
    when source ~ '(느림|지연|렉|버벅|속도|발열|배터리|프리징|로딩|lag|slow|performance|stability)' then '성능/안정성'
    when source ~ '(사용성|불편|ui|ux|디자인|가독성|동선|메뉴|접근성|편의)' then 'UX/UI'
    when source ~ '(요청|기능.?추가|추가해|개선해|지원해|원해|feature request|please add|wish)' then '기능요청'
    when source ~ '(칭찬|좋아|좋음|최고|만족|감사|추천|great|love|excellent|awesome)' then '긍정피드백'
    else '기타/일반'
  end
  from src;
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
      public.normalize_review_category(ai.category, ai.summary, r.content) as normalized_category
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
      where rating = 1
        and normalized_category in ('기능오류', '결제/구독', '계정/로그인', '성능/안정성')
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
      where r.rating = 1
        and public.normalize_review_category(ai.category, ai.summary, r.content) in ('기능오류', '결제/구독', '계정/로그인', '성능/안정성')
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
