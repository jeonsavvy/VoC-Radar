-- Follow-up for production databases that already applied pipeline_stabilization.
-- Qualify PL/pgSQL output-variable conflicts and cover the composite review FK.

create index if not exists idx_pipeline_review_ai_staging_review_scope
  on public.pipeline_review_ai_staging (review_id, app_store_id, country);

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

revoke execute on function public.persist_pipeline_reviews(uuid, uuid, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.persist_issue_clusters(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.record_pipeline_parse_error(uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.persist_pipeline_reviews(uuid, uuid, text, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.persist_issue_clusters(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb)
  to service_role;
grant execute on function public.record_pipeline_parse_error(uuid, uuid, text, text, text, text, text, text)
  to service_role;
