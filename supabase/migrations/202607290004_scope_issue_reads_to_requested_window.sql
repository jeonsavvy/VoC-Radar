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
