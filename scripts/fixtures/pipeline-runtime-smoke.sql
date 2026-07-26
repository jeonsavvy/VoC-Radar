do $$
declare
  claimed record;
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
