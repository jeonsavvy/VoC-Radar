-- A public report represents one published analysis run. Selecting the latest
-- snapshot independently for every cluster leaks stale clusters that were not
-- present in the latest run, so anchor the list to one app-level run first.
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

revoke all on function public.get_public_issue_clusters(text, text, integer) from public;
grant execute on function public.get_public_issue_clusters(text, text, integer) to anon, authenticated;

-- Direct issue links must follow the same report boundary as the list. A stale
-- cluster from an older run is therefore not readable after a newer run is
-- published for the app.
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

revoke all on function public.get_public_issue_detail(uuid) from public;
grant execute on function public.get_public_issue_detail(uuid) to anon, authenticated;
