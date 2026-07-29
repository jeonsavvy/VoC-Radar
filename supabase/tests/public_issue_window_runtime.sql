do $$
declare
  runtime_job record;
  cluster_id_value uuid;
begin
  select id, claim_token into runtime_job
  from public.pipeline_jobs
  where app_store_id = 'runtime-review-app'
    and country = 'kr'
    and status = 'running';

  if runtime_job.id is null or runtime_job.claim_token is null then
    raise exception 'runtime issue-window publish job is unavailable';
  end if;

  perform *
  from public.publish_pipeline_run(
    runtime_job.id,
    runtime_job.claim_token,
    'runtime-review-run',
    'runtime-review-app',
    'kr',
    '2026-07-27T01:00:00Z'
  );

  insert into public.pipeline_jobs (app_store_id, country, app_name)
  values ('runtime-review-app', 'kr', 'Runtime Review App');

  select * into runtime_job
  from public.claim_pipeline_job(
    'runtime-review-claim-2',
    'runtime-review-app',
    'kr',
    'Runtime Review App'
  );

  perform *
  from public.persist_pipeline_reviews(
    runtime_job.job_id,
    runtime_job.claim_token,
    'runtime-review-run-2',
    'runtime-review-app',
    'kr',
    'Runtime Review App',
    'n8n',
    '[{"review_id":"runtime-review-2","rating":2,"author":"tester-2","content":"second sample","reviewed_at":"2026-07-28T00:00:00Z","raw_source":{},"priority":"High","category":"버그 및 성능","issue_label":"issue","reason_summary":"reason","action_hint":"action","summary":"summary","confidence":0.9,"model_version":"runtime-check-2"}]'::jsonb
  );

  perform *
  from public.persist_issue_clusters(
    runtime_job.job_id,
    runtime_job.claim_token,
    'runtime-review-run-2',
    'runtime-review-app',
    'kr',
    'runtime-check-2',
    '2026-07-01T00:00:00Z',
    '2026-07-28T00:00:00Z',
    true,
    '[{"canonical_key":"runtime-issue","title":"Runtime issue current","category":"버그 및 성능","first_seen_at":"2026-07-27T00:00:00Z","last_seen_at":"2026-07-28T00:00:00Z","severity":"medium","review_ids":["runtime-review-2"],"representative_review_ids":["runtime-review-2"],"summary":"current summary","action_hint":"current action"}]'::jsonb,
    '{"passed":true}'::jsonb
  );

  perform *
  from public.publish_pipeline_run(
    runtime_job.job_id,
    runtime_job.claim_token,
    'runtime-review-run-2',
    'runtime-review-app',
    'kr',
    '2026-07-28T01:00:00Z'
  );

  select id into cluster_id_value
  from public.issue_clusters
  where app_store_id = 'runtime-review-app'
    and country = 'kr'
    and canonical_key = 'runtime-issue';

  insert into public.reviews (
    review_id, app_store_id, country, rating, author, content, reviewed_at, raw_source
  )
  select 'runtime-bulk-' || item::text, 'runtime-review-app', 'kr', 2,
    'bulk tester', 'bulk evidence ' || item::text,
    '2026-07-28T12:00:00Z'::timestamptz + item * interval '1 second', '{}'::jsonb
  from generate_series(1, 50) item;

  insert into public.review_ai (
    review_id, priority, category, issue_label, reason_summary, action_hint,
    summary, confidence, model_version
  )
  select 'runtime-bulk-' || item::text, 'High', '버그 및 성능', 'issue', 'reason',
    'action', 'bulk summary ' || item::text, 0.9, 'runtime-check-2'
  from generate_series(1, 50) item;

  insert into public.issue_cluster_reviews (run_id, review_id, cluster_id, is_representative)
  select 'runtime-review-run-2', 'runtime-bulk-' || item::text, cluster_id_value, item <= 2
  from generate_series(1, 50) item;

  insert into public.reviews (
    review_id, app_store_id, country, rating, author, content, reviewed_at, raw_source
  ) values (
    'runtime-boundary-review', 'runtime-review-app', 'kr', 1, 'boundary tester',
    'inclusive upper boundary', '2026-07-30T00:00:00Z', '{}'::jsonb
  );

  insert into public.review_ai (
    review_id, priority, category, issue_label, reason_summary, action_hint,
    summary, confidence, model_version
  ) values (
    'runtime-boundary-review', 'Critical', '버그 및 성능', 'issue', 'reason',
    'action', 'boundary summary', 0.9, 'runtime-check-2'
  );

  insert into public.issue_cluster_reviews (run_id, review_id, cluster_id, is_representative)
  values ('runtime-review-run-2', 'runtime-boundary-review', cluster_id_value, false);

  insert into public.pipeline_jobs (app_store_id, country, app_name, source)
  values ('runtime-review-app', 'kr', 'Runtime Review App', 'reanalysis');

  select * into runtime_job
  from public.claim_pipeline_job(
    'runtime-review-claim-3',
    'runtime-review-app',
    'kr',
    'Runtime Review App'
  );

  perform *
  from public.persist_pipeline_reviews(
    runtime_job.job_id,
    runtime_job.claim_token,
    'runtime-review-run-3',
    'runtime-review-app',
    'kr',
    'Runtime Review App',
    'reanalysis',
    '[{"review_id":"runtime-review-1","rating":1,"author":"tester","content":"sample","reviewed_at":"2026-07-27T00:00:00Z","raw_source":{},"priority":"High","category":"기능 및 사용성","issue_label":"reclassified","reason_summary":"new reason","action_hint":"new action","summary":"new summary","confidence":0.9,"model_version":"runtime-check-3"}]'::jsonb
  );

  perform *
  from public.persist_issue_clusters(
    runtime_job.job_id,
    runtime_job.claim_token,
    'runtime-review-run-3',
    'runtime-review-app',
    'kr',
    'runtime-check-3',
    '2026-07-01T00:00:00Z',
    '2026-07-29T00:00:00Z',
    false,
    '[{"canonical_key":"runtime-reclassified","title":"Runtime reclassified","category":"기능 및 사용성","first_seen_at":"2026-07-27T00:00:00Z","last_seen_at":"2026-07-27T00:00:00Z","severity":"high","review_ids":["runtime-review-1"],"representative_review_ids":["runtime-review-1"],"summary":"reclassified summary","action_hint":"reclassified action"}]'::jsonb,
    '{"passed":true}'::jsonb
  );

  perform *
  from public.publish_pipeline_run(
    runtime_job.job_id,
    runtime_job.claim_token,
    'runtime-review-run-3',
    'runtime-review-app',
    'kr',
    '2026-07-29T01:00:00Z'
  );
end;
$$;

do $$
begin
  if has_function_privilege(
    'anon',
    'public.get_public_issue_clusters_windowed(text,text,integer,timestamptz,timestamptz)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.get_public_issue_detail_windowed(uuid,timestamptz,timestamptz)',
    'execute'
  ) then
    raise exception 'windowed issue RPCs remain directly callable by public API roles';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.get_public_issue_clusters_windowed(text,text,integer,timestamptz,timestamptz)',
    'execute'
  ) then
    raise exception 'service role cannot execute the windowed issue RPC';
  end if;
end;
$$;

set role service_role;

do $$
declare
  current_issue record;
  reclassified_issue record;
  matching_detail jsonb;
  outside_detail jsonb;
  result_count integer;
begin
  if to_regprocedure('public.get_public_issue_clusters(text,text,integer)') is null
    or to_regprocedure('public.get_public_issue_detail(uuid)') is null then
    raise exception 'legacy issue RPCs required for Worker rollback are missing';
  end if;
  if has_function_privilege('anon', 'public.get_public_issue_clusters(text,text,integer)', 'execute')
    or has_function_privilege('authenticated', 'public.get_public_issue_detail(uuid)', 'execute') then
    raise exception 'legacy rollback issue RPCs remain directly callable by public API roles';
  end if;

  select count(*) into result_count
  from public.get_public_issue_clusters_windowed(
    'runtime-review-app',
    'kr',
    50,
    '2026-07-26T00:00:00Z',
    '2026-07-29T23:59:59.999Z'
  );

  if result_count <> 2 then
    raise exception 'multiple published runs were not aggregated';
  end if;

  select * into current_issue
  from public.get_public_issue_clusters_windowed(
    'runtime-review-app',
    'kr',
    50,
    '2026-07-26T00:00:00Z',
    '2026-07-29T23:59:59.999Z'
  )
  where title = 'Runtime issue current';

  if current_issue.issue_id is null
    or current_issue.review_count <> 51
    or current_issue.evidence_count <> 51
    or current_issue.total_count <> 2
    or current_issue.last_occurred_at <> '2026-07-28T12:00:50Z'::timestamptz
    or current_issue.change_percent is not null
    or current_issue.run_id <> 'runtime-review-run-2' then
    raise exception 'prior-run evidence or latest canonical metadata was not preserved';
  end if;

  select * into reclassified_issue
  from public.get_public_issue_clusters_windowed(
    'runtime-review-app',
    'kr',
    50,
    '2026-07-26T00:00:00Z',
    '2026-07-29T23:59:59.999Z'
  )
  where title = 'Runtime reclassified';

  if reclassified_issue.issue_id is null
    or reclassified_issue.review_count <> 1
    or reclassified_issue.last_occurred_at <> '2026-07-27T00:00:00Z'::timestamptz
    or reclassified_issue.run_id <> 'runtime-review-run-3' then
    raise exception 'latest review membership did not replace its prior classification';
  end if;

  select public.get_public_issue_detail_windowed(
    current_issue.issue_id,
    '2026-07-26T00:00:00Z',
    '2026-07-29T23:59:59.999Z'
  ) into matching_detail;

  if matching_detail is null
    or (matching_detail->'issue'->>'reviewCount')::integer <> 51
    or (matching_detail->'issue'->>'evidenceCount')::integer <> 51
    or matching_detail->'issue'->'changePercent' is distinct from 'null'::jsonb
    or jsonb_array_length(matching_detail->'reviews') <> 50
    or exists (
      select 1 from jsonb_array_elements(matching_detail->'reviews') review
      where review->>'reviewId' = 'runtime-review-1'
    ) then
    raise exception 'bounded detail evidence did not preserve the full count or latest membership';
  end if;

  select public.get_public_issue_detail_windowed(
    reclassified_issue.issue_id,
    '2026-07-26T00:00:00Z',
    '2026-07-29T23:59:59.999Z'
  ) into matching_detail;

  if matching_detail is null
    or jsonb_array_length(matching_detail->'reviews') <> 1
    or matching_detail->'reviews'->0->>'reviewId' <> 'runtime-review-1' then
    raise exception 'reclassified detail omitted the latest review membership';
  end if;

  select * into current_issue
  from public.get_public_issue_clusters_windowed(
    'runtime-review-app',
    'kr',
    50,
    '2026-07-30T00:00:00Z',
    '2026-07-30T00:00:00Z'
  );

  if current_issue.review_count <> 1
    or current_issue.last_occurred_at <> '2026-07-30T00:00:00Z'::timestamptz then
    raise exception 'explicit upper review boundary is not inclusive';
  end if;

  select count(*) into result_count
  from public.get_public_issue_clusters_windowed(
    'runtime-review-app',
    'kr',
    50,
    '2026-07-30T00:00:00.001Z',
    '2026-07-31T00:00:00Z'
  );

  if result_count <> 0 then
    raise exception 'issue evidence outside the requested window was exposed';
  end if;

  select public.get_public_issue_detail_windowed(
    reclassified_issue.issue_id,
    '2026-07-30T00:00:00.001Z',
    '2026-07-31T00:00:00Z'
  ) into outside_detail;

  if outside_detail is not null then
    raise exception 'issue detail evidence outside the requested window was exposed';
  end if;

  select count(*) into result_count
  from public.get_public_issue_clusters_windowed(
    'runtime-review-app', 'kr', 50,
    '2026-01-01T00:00:00Z', '2026-04-02T00:00:00.001Z'
  );

  if result_count <> 0 then
    raise exception 'issue list accepted a window larger than 90 days';
  end if;

  select public.get_public_issue_detail_windowed(
    reclassified_issue.issue_id,
    '2026-07-26T00:00:00Z',
    null
  ) into outside_detail;

  if outside_detail is not null then
    raise exception 'issue detail accepted an incomplete window';
  end if;
end;
$$;

reset role;
