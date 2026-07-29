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
