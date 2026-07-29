do $$
declare
  user_a constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  user_b constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  user_c constant uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  user_d constant uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  queued_job_id uuid;
  result jsonb;
begin
  insert into auth.users (id) values (user_a), (user_b), (user_c), (user_d)
  on conflict (id) do nothing;

  if has_function_privilege('anon', 'public.enqueue_pipeline_job(text,text,text,text,uuid,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.enqueue_pipeline_job(text,text,text,text,uuid,integer)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.enqueue_pipeline_job(text,text,text,text,uuid,integer)', 'EXECUTE') then
    raise exception 'pipeline enqueue RPC privilege boundary failed';
  end if;

  result := public.enqueue_pipeline_job('7000000001', 'kr', 'Quota A1', null, user_a, 2);
  if result ->> 'result' <> 'queued' then
    raise exception 'first quota job was not queued';
  end if;
  queued_job_id := (result #>> '{data,id}')::uuid;
  update public.pipeline_jobs
  set status = 'canceled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = queued_job_id;

  result := public.enqueue_pipeline_job('7000000002', 'kr', 'Quota A2', 'private web note', user_a, 2);
  if result ->> 'result' <> 'queued' then
    raise exception 'second quota job was not queued';
  end if;

  result := public.enqueue_pipeline_job('7000000002', 'kr', 'Quota A2', null, user_a, 2);
  if result ->> 'result' <> 'existing'
    or (select count(*) from public.pipeline_jobs where requested_by = user_a and source = 'web') <> 2 then
    raise exception 'existing active job consumed quota';
  end if;

  result := public.enqueue_pipeline_job('7000000002', 'kr', 'Quota A2', null, user_b, 2);
  if result ->> 'result' <> 'existing'
    or result -> 'data' ? 'note'
    or result -> 'data' ? 'source' then
    raise exception 'cross-user active web job exposed private enqueue fields';
  end if;

  insert into public.pipeline_jobs (
    app_store_id, country, app_name, source, status, stage, note
  ) values (
    '7000000010', 'kr', 'Operator App', 'reanalysis', 'queued', 'queued', 'private operator note'
  );
  result := public.enqueue_pipeline_job('7000000010', 'kr', 'Operator App', null, user_c, 2);
  if result ->> 'result' <> 'existing'
    or result -> 'data' ? 'note'
    or result -> 'data' ? 'source' then
    raise exception 'active reanalysis job exposed operator fields';
  end if;
  update public.pipeline_jobs
  set status = 'canceled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
  where app_store_id = '7000000010' and country = 'kr' and status = 'queued';

  result := public.enqueue_pipeline_job('7000000003', 'kr', 'Must Not Persist', null, user_a, 2);
  if result ->> 'result' <> 'quota_exceeded'
    or result ->> 'retryAt' is null
    or exists (
      select 1 from public.apps
      where app_store_id = '7000000003' and country = 'kr'
    )
    or exists (
      select 1 from public.pipeline_jobs
      where app_store_id = '7000000003' and country = 'kr'
    ) then
    raise exception 'rolling quota rejection was not atomic';
  end if;

  result := public.enqueue_pipeline_job('7000000003', 'kr', 'Independent User', null, user_b, 2);
  if result ->> 'result' <> 'queued' then
    raise exception 'one user quota blocked a different user';
  end if;

  insert into public.apps (app_store_id, country, app_name)
  values ('7000000004', 'kr', 'Preserved App Name');
  result := public.enqueue_pipeline_job('7000000004', 'kr', null, null, user_c, 1);
  if result ->> 'result' <> 'queued'
    or (select app_name from public.apps where app_store_id = '7000000004' and country = 'kr') <> 'Preserved App Name'
    or result #>> '{data,app_name}' <> 'Preserved App Name' then
    raise exception 'unverified app enqueue replaced existing metadata';
  end if;

  insert into public.pipeline_jobs (
    app_store_id, country, source, status, requested_by, requested_at
  ) values
    ('7000000005', 'kr', 'web', 'canceled', user_d, clock_timestamp() - interval '4 hours'),
    ('7000000006', 'kr', 'web', 'failed', user_d, clock_timestamp() - interval '3 hours'),
    ('7000000007', 'kr', 'web', 'completed', user_d, clock_timestamp() - interval '2 hours'),
    ('7000000008', 'kr', 'web', 'canceled', user_d, clock_timestamp() - interval '1 hour');

  result := public.enqueue_pipeline_job('7000000009', 'kr', 'Over Limit', null, user_d, 2);
  if result ->> 'result' <> 'quota_exceeded'
    or (result ->> 'retryAt')::timestamptz <> (
      select requested_at + interval '24 hours'
      from public.pipeline_jobs
      where requested_by = user_d and source = 'web'
      order by requested_at asc, id asc
      offset 2
      limit 1
    ) then
    raise exception 'over-limit quota retry timestamp was too early';
  end if;

  if (select count(*) from public.pipeline_jobs where requested_by = user_a and source = 'web') <> 2
    or not exists (
      select 1 from public.pipeline_jobs
      where requested_by = user_a and source = 'web' and status = 'canceled'
    ) then
    raise exception 'canceled web jobs did not remain in rolling quota accounting';
  end if;

  update public.pipeline_jobs
  set status = 'canceled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
  where requested_by in (user_a, user_b, user_c, user_d)
    and status in ('queued', 'running');
end;
$$;

do $$
declare
  boundary_claim record;
  boundary_reviews jsonb;
  cluster_boundary jsonb;
begin
  insert into public.pipeline_jobs (app_store_id, country, app_name)
  values ('runtime-boundary-small', 'kr', 'Runtime Boundary Small');

  select * into boundary_claim
  from public.claim_pipeline_job(
    'runtime-boundary-small-claim',
    'runtime-boundary-small',
    'kr',
    'Runtime Boundary Small'
  );

  begin
    perform * from public.persist_pipeline_reviews(
      boundary_claim.job_id, boundary_claim.claim_token, 'runtime-boundary-small-run',
      'runtime-boundary-small', 'kr', 'Runtime Boundary Small', 'runtime-check', '[]'::jsonb
    );
    raise exception 'empty review persistence payload was accepted';
  exception
    when sqlstate '22023' then null;
  end;

  select jsonb_agg(jsonb_build_object(
    'review_id', 'runtime-boundary-invalid-' || series.value,
    'rating', 1,
    'author', 'tester',
    'content', 'invalid oversized boundary payload',
    'reviewed_at', '2026-07-29T00:00:00Z',
    'raw_source', '{}'::jsonb,
    'priority', 'Normal',
    'category', '긍정 리뷰 및 기타',
    'summary', 'boundary',
    'confidence', 0.9,
    'model_version', 'runtime-check'
  ) order by series.value)
  into boundary_reviews
  from generate_series(1, 10001) as series(value);

  begin
    perform * from public.persist_pipeline_reviews(
      boundary_claim.job_id, boundary_claim.claim_token, 'runtime-boundary-small-run',
      'runtime-boundary-small', 'kr', 'Runtime Boundary Small', 'runtime-check', boundary_reviews
    );
    raise exception 'oversized review persistence payload was accepted';
  exception
    when sqlstate '22023' then null;
  end;

  if (select stage from public.pipeline_jobs where id = boundary_claim.job_id) <> 'fetching' then
    raise exception 'invalid review count renewed the pipeline claim';
  end if;

  perform * from public.persist_pipeline_reviews(
    boundary_claim.job_id,
    boundary_claim.claim_token,
    'runtime-boundary-small-run',
    'runtime-boundary-small',
    'kr',
    'Runtime Boundary Small',
    'runtime-check',
    '[{"review_id":"runtime-boundary-small-1","rating":1,"author":"tester","content":"single boundary payload","reviewed_at":"2026-07-29T00:00:00Z","raw_source":{},"priority":"Normal","category":"긍정 리뷰 및 기타","summary":"boundary","confidence":0.9,"model_version":"runtime-check"}]'::jsonb
  );
  if (select count(*) from public.pipeline_review_ai_staging where run_id = 'runtime-boundary-small-run') <> 1 then
    raise exception 'one-review persistence boundary was rejected';
  end if;

  select jsonb_agg(jsonb_build_object(
    'canonical_key', 'runtime-boundary-cluster-' || series.value,
    'title', 'Boundary cluster',
    'category', '기능 및 사용성',
    'severity', 'low',
    'review_ids', jsonb_build_array('runtime-boundary-small-1'),
    'representative_review_ids', jsonb_build_array('runtime-boundary-small-1'),
    'first_seen_at', '2026-07-29T00:00:00Z',
    'last_seen_at', '2026-07-29T00:00:00Z',
    'summary', 'boundary'
  ) order by series.value)
  into cluster_boundary
  from generate_series(1, 10001) as series(value);

  begin
    perform * from public.persist_issue_clusters(
      boundary_claim.job_id, boundary_claim.claim_token, 'runtime-boundary-small-run',
      'runtime-boundary-small', 'kr', 'runtime-check', null, null, true,
      cluster_boundary, '{"passed":true}'::jsonb
    );
    raise exception 'oversized cluster persistence payload was accepted';
  exception
    when sqlstate '22023' then null;
  end;

  select jsonb_build_array(jsonb_build_object(
    'canonical_key', 'runtime-boundary-memberships',
    'title', 'Boundary memberships',
    'category', '기능 및 사용성',
    'severity', 'low',
    'review_ids', jsonb_agg(to_jsonb('runtime-boundary-member-' || series.value)),
    'representative_review_ids', '[]'::jsonb,
    'first_seen_at', '2026-07-29T00:00:00Z',
    'last_seen_at', '2026-07-29T00:00:00Z',
    'summary', 'boundary'
  ))
  into cluster_boundary
  from generate_series(1, 10001) as series(value);

  begin
    perform * from public.persist_issue_clusters(
      boundary_claim.job_id, boundary_claim.claim_token, 'runtime-boundary-small-run',
      'runtime-boundary-small', 'kr', 'runtime-check', null, null, true,
      cluster_boundary, '{"passed":true}'::jsonb
    );
    raise exception 'oversized membership persistence payload was accepted';
  exception
    when sqlstate '22023' then null;
  end;

  if (select stage from public.pipeline_jobs where id = boundary_claim.job_id) <> 'clustering' then
    raise exception 'invalid cluster or membership count renewed the pipeline claim';
  end if;

  update public.pipeline_jobs
  set status = 'canceled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = boundary_claim.job_id;

  insert into public.pipeline_jobs (app_store_id, country, app_name)
  values ('runtime-boundary-large', 'kr', 'Runtime Boundary Large');

  select * into boundary_claim
  from public.claim_pipeline_job(
    'runtime-boundary-large-claim',
    'runtime-boundary-large',
    'kr',
    'Runtime Boundary Large'
  );

  select jsonb_agg(jsonb_build_object(
    'review_id', 'runtime-boundary-large-' || series.value,
    'rating', 1,
    'author', 'tester',
    'content', 'maximum boundary payload',
    'reviewed_at', '2026-07-29T00:00:00Z',
    'raw_source', '{}'::jsonb,
    'priority', 'Normal',
    'category', '긍정 리뷰 및 기타',
    'summary', 'boundary',
    'confidence', 0.9,
    'model_version', 'runtime-check'
  ) order by series.value)
  into boundary_reviews
  from generate_series(1, 10000) as series(value);

  perform * from public.persist_pipeline_reviews(
    boundary_claim.job_id, boundary_claim.claim_token, 'runtime-boundary-large-run',
    'runtime-boundary-large', 'kr', 'Runtime Boundary Large', 'runtime-check', boundary_reviews
  );
  if (select count(*) from public.pipeline_review_ai_staging where run_id = 'runtime-boundary-large-run') <> 10000 then
    raise exception '10000-review persistence boundary was rejected';
  end if;

  update public.pipeline_jobs
  set status = 'canceled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = boundary_claim.job_id;
end;
$$;

do $$
declare
  claimed record;
  renewed record;
  regression_count integer;
  current_stage text;
  scoped_reviews jsonb;
  historical_context_cluster_id uuid;
  new_context_cluster_id uuid;
begin
  insert into public.pipeline_jobs (app_store_id, country, app_name)
  values ('runtime-review-app', 'kr', 'Runtime Review App');

  select * into claimed
  from public.claim_pipeline_job('runtime-review-claim', 'runtime-review-app', 'kr', 'Runtime Review App');

  perform *
  from public.persist_pipeline_reviews(
    claimed.job_id,
    claimed.claim_token,
    'runtime-review-run',
    'runtime-review-app',
    'kr',
    'Runtime Review App',
    'n8n',
    '[{"review_id":"runtime-review-1","rating":1,"author":"tester","content":"sample","reviewed_at":"2026-07-27T00:00:00Z","raw_source":{},"priority":"High","category":"버그 및 성능","issue_label":"issue","reason_summary":"reason","action_hint":"action","summary":"summary","confidence":0.9,"model_version":"runtime-check"}]'::jsonb
  );

  insert into public.reviews (
    review_id, app_store_id, country, rating, author, content, reviewed_at, raw_source
  ) values (
    'runtime-review-2', 'runtime-review-app', 'kr', 2, 'tester', 'second sample',
    '2026-07-26T00:00:00Z', '{}'::jsonb
  );

  select public.get_pipeline_review_scope(
    'runtime-review-app',
    'kr',
    array['runtime-review-2', 'runtime-review-1'],
    false
  ) into scoped_reviews;
  if jsonb_array_length(scoped_reviews) <> 2
    or scoped_reviews->0->>'review_id' <> 'runtime-review-2'
    or scoped_reviews->1->>'review_id' <> 'runtime-review-1'
    or scoped_reviews->0 ? 'priority' then
    raise exception 'raw pipeline review scope lookup was incomplete or unordered';
  end if;

  insert into public.review_ai (review_id, priority, category, summary, model_version)
  values
    ('runtime-review-1', 'High', '버그 및 성능', 'first analysis', 'runtime-check'),
    ('runtime-review-2', 'Normal', '긍정 리뷰 및 기타', 'second analysis', 'runtime-check');

  select public.get_pipeline_review_scope(
    'runtime-review-app',
    'kr',
    array['runtime-review-2', 'runtime-review-1', 'missing-review'],
    true
  ) into scoped_reviews;
  if jsonb_array_length(scoped_reviews) <> 2
    or scoped_reviews->0->>'review_id' <> 'runtime-review-2'
    or scoped_reviews->0->>'summary' <> 'second analysis'
    or scoped_reviews->1->>'review_id' <> 'runtime-review-1' then
    raise exception 'committed pipeline review scope lookup was incomplete or unordered';
  end if;

  begin
    perform public.get_pipeline_review_scope(
      'runtime-review-app', 'kr', array['runtime-review-1', 'runtime-review-1'], true
    );
    raise exception 'pipeline review scope lookup accepted duplicate IDs';
  exception when check_violation then
    null;
  end;

  begin
    perform public.get_pipeline_review_scope(
      'runtime-review-app', 'kr', array_fill('runtime-review-1'::text, array[10001]), true
    );
    raise exception 'pipeline review scope lookup accepted more than 10000 IDs';
  exception when invalid_parameter_value then
    null;
  end;

  select * into renewed
  from public.renew_pipeline_job_claim(
    claimed.job_id,
    claimed.claim_token,
    'runtime-review-run',
    'clustering'
  );
  if renewed.job_id is null or renewed.stage <> 'clustering' then
    raise exception 'same-stage pipeline heartbeat was rejected';
  end if;

  select count(*) into regression_count
  from public.renew_pipeline_job_claim(
    claimed.job_id,
    claimed.claim_token,
    'runtime-review-run',
    'extracting'
  );
  select stage into current_stage from public.pipeline_jobs where id = claimed.job_id;
  if regression_count <> 0 or current_stage <> 'clustering' then
    raise exception 'pipeline heartbeat moved a job back to an earlier stage';
  end if;

  perform *
  from public.persist_pipeline_reviews(
    claimed.job_id,
    claimed.claim_token,
    'runtime-review-run',
    'runtime-review-app',
    'kr',
    'Runtime Review App',
    'n8n',
    '[{"review_id":"runtime-review-1","rating":1,"author":"tester","content":"sample","reviewed_at":"2026-07-27T00:00:00Z","raw_source":{},"priority":"High","category":"버그 및 성능","issue_label":"issue","reason_summary":"reason","action_hint":"action","summary":"summary","confidence":0.9,"model_version":"runtime-check"}]'::jsonb
  );

  perform *
  from public.persist_issue_clusters(
    claimed.job_id,
    claimed.claim_token,
    'runtime-review-run',
    'runtime-review-app',
    'kr',
    'runtime-check',
    '2026-07-01T00:00:00Z',
    '2026-07-27T00:00:00Z',
    true,
    '[{"canonical_key":"runtime-issue","title":"Runtime issue","category":"버그 및 성능","first_seen_at":"2026-07-27T00:00:00Z","last_seen_at":"2026-07-27T00:00:00Z","severity":"low","review_ids":["runtime-review-1"],"representative_review_ids":["runtime-review-1"],"summary":"summary","action_hint":"action"}]'::jsonb,
    '{"passed":true}'::jsonb
  );

  perform *
  from public.persist_issue_clusters(
    claimed.job_id,
    claimed.claim_token,
    'runtime-review-run',
    'runtime-review-app',
    'kr',
    'runtime-check',
    '2026-07-01T00:00:00Z',
    '2026-07-27T00:00:00Z',
    true,
    '[{"canonical_key":"runtime-issue","title":"Runtime issue","category":"버그 및 성능","first_seen_at":"2026-07-27T00:00:00Z","last_seen_at":"2026-07-27T00:00:00Z","severity":"low","review_ids":["runtime-review-1"],"representative_review_ids":["runtime-review-1"],"summary":"summary","action_hint":"action"}]'::jsonb,
    '{"passed":true}'::jsonb
  );

  begin
    perform *
    from public.complete_pipeline_job(
      claimed.job_id,
      claimed.claim_token,
      'running',
      'fetching',
      'runtime-review-run',
      null
    );
    raise exception 'generic job status update accepted a regressive running stage';
  exception when check_violation then
    null;
  end;

  select stage into current_stage from public.pipeline_jobs where id = claimed.job_id;
  if current_stage <> 'publishing' then
    raise exception 'generic job status update moved a job back to an earlier stage';
  end if;

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count,
    executed_at, published_at, model_version, validation_status, validation_result
  ) values (
    'runtime-context-run', 'runtime-context-app', 'kr', 'runtime-check',
    'published', 101, now(), now(), 'runtime-check', 'passed', '{"passed":true}'::jsonb
  );

  with inserted_clusters as (
    insert into public.issue_clusters (
      app_store_id, country, canonical_key, title, category,
      first_seen_at, last_seen_at, current_run_id, model_version
    )
    select
      'runtime-context-app',
      'kr',
      'runtime-extra-' || lpad(series.value::text, 3, '0'),
      'Runtime extra ' || series.value,
      '기능 및 사용성',
      '2026-07-26T00:00:00Z'::timestamptz,
      '2026-07-27T00:00:00Z'::timestamptz,
      'runtime-context-run',
      'runtime-check'
    from generate_series(1, 101) as series(value)
    returning id, title, category, first_seen_at, last_seen_at, model_version
  )
  insert into public.issue_cluster_snapshots (
    cluster_id, run_id, severity, review_count, evidence_count, summary,
    validation_status, validation_result, title, category,
    first_seen_at, last_seen_at, model_version
  )
  select
    inserted.id,
    'runtime-context-run',
    'low',
    1,
    1,
    case
      when inserted.title = 'Runtime extra 101' then repeat('L', 500)
      else inserted.title || ' summary'
    end,
    'passed',
    '{"passed":true}'::jsonb,
    inserted.title,
    inserted.category,
    inserted.first_seen_at,
    inserted.last_seen_at,
    inserted.model_version
  from inserted_clusters as inserted;

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count,
    executed_at, published_at, model_version, validation_status, validation_result
  ) values (
    'runtime-context-run-2', 'runtime-context-app', 'kr', 'runtime-check',
    'published', 2, now(), now() + interval '1 minute', 'runtime-check-v2',
    'passed', '{"passed":true}'::jsonb
  );

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count,
    executed_at, published_at, model_version, validation_status, validation_result
  ) values (
    'runtime-context-cross-scope-run', 'runtime-other-app', 'us', 'runtime-check',
    'published', 1, now(), now() + interval '2 minutes', 'runtime-cross-scope',
    'passed', '{"passed":true}'::jsonb
  );

  select id into historical_context_cluster_id
  from public.issue_clusters
  where app_store_id = 'runtime-context-app'
    and country = 'kr'
    and canonical_key = 'runtime-extra-001';

  insert into public.issue_cluster_snapshots (
    cluster_id, run_id, severity, review_count, evidence_count, summary,
    validation_status, validation_result, title, category,
    first_seen_at, last_seen_at, model_version
  ) values (
    historical_context_cluster_id,
    'runtime-context-run-2',
    'medium',
    2,
    2,
    'newer historical identity summary',
    'passed',
    '{"passed":true}'::jsonb,
    'Runtime extra 1 updated',
    '기능 및 사용성',
    '2026-07-26T00:00:00Z',
    '2026-07-28T00:00:00Z',
    'runtime-check-v2'
  );

  insert into public.issue_cluster_snapshots (
    cluster_id, run_id, severity, review_count, evidence_count, summary,
    validation_status, validation_result, title, category,
    first_seen_at, last_seen_at, model_version
  ) values (
    historical_context_cluster_id,
    'runtime-context-cross-scope-run',
    'high',
    999,
    999,
    'cross-scope contaminated summary',
    'passed',
    '{"passed":true}'::jsonb,
    'Cross-scope contaminated title',
    '기능 및 사용성',
    '2026-07-26T00:00:00Z',
    '2026-07-29T00:00:00Z',
    'runtime-cross-scope'
  );

  insert into public.issue_clusters (
    app_store_id, country, canonical_key, title, category,
    first_seen_at, last_seen_at, current_run_id, model_version
  ) values (
    'runtime-context-app', 'kr', 'runtime-latest-new', 'Runtime latest new',
    '버그 및 성능', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z',
    'runtime-context-run-2', 'runtime-check-v2'
  ) returning id into new_context_cluster_id;

  insert into public.issue_cluster_snapshots (
    cluster_id, run_id, severity, review_count, evidence_count, summary,
    validation_status, validation_result, title, category,
    first_seen_at, last_seen_at, model_version
  ) values (
    new_context_cluster_id,
    'runtime-context-run-2',
    'high',
    1,
    1,
    'new incremental identity summary',
    'passed',
    '{"passed":true}'::jsonb,
    'Runtime latest new',
    '버그 및 성능',
    '2026-07-28T00:00:00Z',
    '2026-07-28T00:00:00Z',
    'runtime-check-v2'
  );

  select public.get_pipeline_cluster_context_v2('runtime-context-app', 'kr')
  into scoped_reviews;
  if jsonb_array_length(scoped_reviews) <> 102
    or not (scoped_reviews @> '[{"canonical_key":"runtime-extra-101"}]'::jsonb)
    or not (scoped_reviews @> jsonb_build_array(jsonb_build_object(
      'canonical_key', 'runtime-extra-101', 'summary', repeat('L', 400)
    )))
    or (
      select length(summary)
      from public.issue_cluster_snapshots
      where run_id = 'runtime-context-run' and title = 'Runtime extra 101'
    ) <> 500
    or not (scoped_reviews @> '[{"canonical_key":"runtime-extra-001","summary":"newer historical identity summary"}]'::jsonb)
    or not (scoped_reviews @> '[{"canonical_key":"runtime-latest-new"}]'::jsonb)
    or scoped_reviews @> '[{"summary":"cross-scope contaminated summary"}]'::jsonb
    or scoped_reviews @> '[{"title":"Cross-scope contaminated title"}]'::jsonb then
    raise exception 'bounded pipeline cluster context omitted or stale-matched identities';
  end if;

  insert into public.pipeline_jobs (app_store_id, country, app_name)
  values ('runtime-parse-app', 'kr', 'Runtime Parse App');

  select * into claimed
  from public.claim_pipeline_job('runtime-parse-claim', 'runtime-parse-app', 'kr', 'Runtime Parse App');

  insert into public.parse_errors (parse_error_id, message)
  values ('runtime-parse-1', 'old');

  perform *
  from public.record_pipeline_parse_error(
    claimed.job_id,
    claimed.claim_token,
    'runtime-parse-run',
    'runtime-parse-1',
    'runtime-parse-app',
    'kr',
    'safe parse failure',
    'bounded raw response'
  );
end;
$$;

do $$
begin
  if (select count(*) from public.pipeline_review_ai_staging where run_id = 'runtime-review-run') <> 1 then
    raise exception 'review staging runtime check failed';
  end if;
  if (select count(*) from public.issue_cluster_snapshots where run_id = 'runtime-review-run') <> 1 then
    raise exception 'cluster snapshot runtime check failed';
  end if;
  if (select count(*) from public.issue_cluster_reviews where run_id = 'runtime-review-run') <> 1 then
    raise exception 'cluster membership runtime check failed';
  end if;
  if (select message from public.parse_errors where parse_error_id = 'runtime-parse-1') <> 'safe parse failure' then
    raise exception 'parse error conflict runtime check failed';
  end if;
end;
$$;
