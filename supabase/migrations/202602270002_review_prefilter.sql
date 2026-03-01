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

grant execute on function public.get_existing_review_ids(text, text, text[]) to anon, authenticated;
