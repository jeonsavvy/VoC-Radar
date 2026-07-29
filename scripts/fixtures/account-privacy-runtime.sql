do $$
declare
  deleting_user constant uuid := '80000000-0000-4000-8000-000000000010';
  other_user constant uuid := '80000000-0000-4000-8000-000000000011';
  active_job constant uuid := '80000000-0000-4000-8000-000000000012';
  terminal_job constant uuid := '80000000-0000-4000-8000-000000000013';
  other_job constant uuid := '80000000-0000-4000-8000-000000000014';
  late_job constant uuid := '80000000-0000-4000-8000-000000000015';
  active_claim constant uuid := '80000000-0000-4000-8000-000000000016';
  prepared record;
begin
  if has_function_privilege('anon', 'public.prepare_account_deletion(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.prepare_account_deletion(uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.prepare_account_deletion(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.get_public_apps(integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.get_public_apps(integer)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.get_public_apps(integer)', 'EXECUTE') then
    raise exception 'account privacy or public app RPC privilege boundary failed';
  end if;

  if (select note from public.pipeline_jobs where id = '80000000-0000-4000-8000-000000000001') is not null
    or (select error_message from public.pipeline_jobs where id = '80000000-0000-4000-8000-000000000001')
      <> 'The analysis failed. Retry the request.'
    or (select note from public.pipeline_jobs where id = '80000000-0000-4000-8000-000000000002')
      <> 'operator reanalysis note'
    or (select error_message from public.pipeline_jobs where id = '80000000-0000-4000-8000-000000000002')
      <> 'operator diagnostic retained outside the user surface' then
    raise exception 'legacy owner-readable text sanitization boundary failed';
  end if;

  insert into auth.users (id) values (deleting_user), (other_user);

  insert into public.pipeline_jobs (
    id, app_store_id, country, source, status, requested_by, note, error_message, finished_at
  ) values (
    terminal_job, '8000000010', 'kr', 'web', 'failed', deleting_user,
    'terminal user note', 'review_scope_incomplete', now()
  );

  insert into public.pipeline_jobs (
    id, app_store_id, country, source, status, requested_by, note, error_message, finished_at
  ) values (
    other_job, '8000000011', 'kr', 'web', 'completed', other_user,
    'other user note', null, now()
  );

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count,
    executed_at, model_version, validation_status, validation_result
  ) values (
    'runtime-account-delete-run', '8000000012', 'kr', 'runtime-check', 'upserted', 1,
    now(), 'runtime-check', 'passed', '{"passed":true}'::jsonb
  );

  insert into public.pipeline_jobs (
    id, app_store_id, country, source, status, stage, requested_by, run_id, note,
    claim_key, claim_token, lease_expires_at, last_heartbeat_at, attempt_count, started_at
  ) values (
    active_job, '8000000012', 'kr', 'web', 'running', 'extracting', deleting_user,
    'runtime-account-delete-run', 'active user note', 'runtime-account-delete-claim',
    active_claim, now() + interval '15 minutes', now(), 1, now()
  );

  insert into public.pipeline_job_claims (
    claim_key, job_id, claim_token, attempt_count, lease_expires_at
  ) values (
    'runtime-account-delete-claim', active_job, active_claim, 1, now() + interval '15 minutes'
  );

  insert into public.reviews (
    review_id, app_store_id, country, rating, author, content, reviewed_at, raw_source
  ) values (
    'runtime-account-delete-review', '8000000012', 'kr', 1, 'tester',
    'private staged review', now(), '{}'::jsonb
  );

  insert into public.pipeline_review_ai_staging (
    run_id, review_id, app_store_id, country, rating, author, content, reviewed_at,
    raw_source, priority, category, summary, model_version
  ) values (
    'runtime-account-delete-run', 'runtime-account-delete-review', '8000000012', 'kr',
    1, 'tester', 'private staged review', now(), '{}'::jsonb, 'High',
    '버그 및 성능', 'runtime account delete staging', 'runtime-check'
  );

  select * into prepared from public.prepare_account_deletion(deleting_user);
  if prepared.canceled_jobs <> 1 or prepared.redacted_jobs <> 2 then
    raise exception 'account deletion preparation returned incorrect counts';
  end if;
  if (select status from public.pipeline_jobs where id = active_job) <> 'canceled'
    or (select note from public.pipeline_jobs where id = active_job) is not null
    or (select status from public.pipeline_jobs where id = terminal_job) <> 'failed'
    or (select note from public.pipeline_jobs where id = terminal_job) is not null
    or (select error_message from public.pipeline_jobs where id = terminal_job) <> 'review_scope_incomplete'
    or (select note from public.pipeline_jobs where id = other_job) <> 'other user note' then
    raise exception 'account deletion preparation changed the wrong job state';
  end if;
  if (select status from public.pipeline_runs where run_id = 'runtime-account-delete-run') <> 'failed'
    or (select validation_result ->> 'error' from public.pipeline_runs where run_id = 'runtime-account-delete-run') <> 'job_canceled'
    or exists (select 1 from public.pipeline_review_ai_staging where run_id = 'runtime-account-delete-run')
    or (select terminal_status from public.pipeline_job_claims where claim_key = 'runtime-account-delete-claim') <> 'canceled' then
    raise exception 'account deletion preparation omitted active-job side effects';
  end if;

  -- This models an enqueue that commits after preparation but before the Auth
  -- Admin delete. The FK update must still erase its note.
  insert into public.pipeline_jobs (
    id, app_store_id, country, source, status, stage, requested_by, note
  ) values (
    late_job, '8000000013', 'kr', 'web', 'queued', 'queued', deleting_user, 'late user note'
  );
  delete from auth.users where id = deleting_user;
  if exists (
    select 1 from public.pipeline_jobs
    where id in (active_job, terminal_job, late_job)
      and (requested_by is not null or note is not null)
  ) or (select status from public.pipeline_jobs where id = late_job) <> 'queued' then
    raise exception 'Auth owner removal did not scrub a late job note';
  end if;

  update public.pipeline_jobs
  set status = 'canceled', stage = null, finished_at = now()
  where id = late_job;
end;
$$;

do $$
declare
  code_job constant uuid := '80000000-0000-4000-8000-000000000020';
  generic_job constant uuid := '80000000-0000-4000-8000-000000000021';
  code_claim constant uuid := '80000000-0000-4000-8000-000000000022';
  generic_claim constant uuid := '80000000-0000-4000-8000-000000000023';
begin
  insert into public.pipeline_jobs (
    id, app_store_id, country, source, status, stage, run_id, claim_token,
    lease_expires_at, last_heartbeat_at, attempt_count, started_at
  ) values
    (
      code_job, '8000000020', 'kr', 'web', 'running', 'fetching',
      'runtime-capacity-code-run', code_claim, now() + interval '15 minutes', now(), 1, now()
    ),
    (
      generic_job, '8000000021', 'kr', 'web', 'running', 'fetching',
      'runtime-generic-error-run', generic_claim, now() + interval '15 minutes', now(), 1, now()
    );

  perform * from public.complete_pipeline_job(
    code_job, code_claim, 'failed', null, 'runtime-capacity-code-run', 'review_scope_incomplete'
  );
  perform * from public.complete_pipeline_job(
    generic_job, generic_claim, 'failed', null, 'runtime-generic-error-run',
    'provider response containing private diagnostic detail'
  );

  if (select error_message from public.pipeline_jobs where id = code_job) <> 'review_scope_incomplete'
    or (select error_message from public.pipeline_jobs where id = generic_job)
      <> 'The analysis failed. Retry the request.' then
    raise exception 'pipeline failure allowlist stored an unsafe value';
  end if;
end;
$$;

do $$
declare
  directory jsonb;
begin
  if to_regclass('public.idx_pipeline_runs_public_app_directory') is null then
    raise exception 'public app directory index is missing';
  end if;

  insert into public.apps (app_store_id, country, app_name) values
    ('8000000100', 'kr', 'Directory KR'),
    ('8000000100', 'us', 'Directory US');

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count, executed_at, published_at
  ) values
    ('runtime-directory-kr-old', '8000000100', 'kr', 'runtime-check', 'published', 1, '2099-01-01', '2099-01-01'),
    ('runtime-directory-kr-new', '8000000100', 'kr', 'runtime-check', 'published', 2, '2099-01-05', '2099-01-05'),
    ('runtime-directory-us', '8000000100', 'us', 'runtime-check', 'published', 1, '2099-01-04', '2099-01-04'),
    ('runtime-directory-no-meta', '8000000101', 'kr', 'runtime-check', 'published', 1, '2099-01-03', '2099-01-03'),
    ('runtime-directory-zero', '8000000102', 'kr', 'runtime-check', 'published', 0, '2099-01-07', '2099-01-07'),
    ('runtime-directory-failed', '8000000103', 'kr', 'runtime-check', 'failed', 4, '2099-01-08', null);

  select jsonb_agg(to_jsonb(directory_row) order by directory_row.updated_at desc)
  into directory
  from public.get_public_apps(3) as directory_row;

  if jsonb_array_length(directory) <> 3
    or directory #>> '{0,app_store_id}' <> '8000000100'
    or directory #>> '{0,country}' <> 'kr'
    or directory #>> '{0,app_name}' <> 'Directory KR'
    or directory #>> '{1,country}' <> 'us'
    or directory #>> '{1,app_name}' <> 'Directory US'
    or directory #>> '{2,app_store_id}' <> '8000000101'
    or directory #> '{2,app_name}' <> 'null'::jsonb then
    raise exception 'public app directory did not deduplicate, order, or join exact app scopes';
  end if;

  insert into public.apps (app_store_id, country, app_name)
  select '8100000' || lpad(series.value::text, 3, '0'), 'kr', 'Capacity App ' || series.value
  from generate_series(1, 105) as series(value);

  insert into public.pipeline_runs (
    run_id, app_store_id, country, source, status, review_count, executed_at, published_at
  )
  select
    'runtime-directory-cap-' || series.value,
    '8100000' || lpad(series.value::text, 3, '0'),
    'kr', 'runtime-check', 'published', 1,
    '2100-01-01T00:00:00Z'::timestamptz + series.value * interval '1 second',
    '2100-01-01T00:00:00Z'::timestamptz + series.value * interval '1 second'
  from generate_series(1, 105) as series(value);

  if (select count(*) from public.get_public_apps(101)) <> 100
    or (select count(*) from public.get_public_apps(0)) <> 1 then
    raise exception 'public app directory did not clamp its 1-100 result contract';
  end if;
end;
$$;
