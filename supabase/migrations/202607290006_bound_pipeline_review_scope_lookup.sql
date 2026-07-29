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
