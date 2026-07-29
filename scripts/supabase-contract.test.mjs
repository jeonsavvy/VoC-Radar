import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const schema = readFileSync('supabase/schema.sql', 'utf8');
const enqueuePrepareFixture = readFileSync('scripts/fixtures/pipeline-job-enqueue-prepare.sql', 'utf8');
const hardeningMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_harden_internal_rpc_privileges.sql'),
);
const latestRunMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_scope_issue_list_to_latest_run.sql'),
);
const optimizedRlsMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_optimize_pipeline_job_rls.sql'),
);
const stabilizationMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_pipeline_stabilization.sql'),
);
const stabilizationFixMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_pipeline_stabilization_runtime_fixes.sql'),
);
const enqueuePrepareMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_prepare_pipeline_job_enqueue.sql'),
);
const enqueueHardenMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_harden_pipeline_job_enqueue.sql'),
);
const issueWindowMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_scope_issue_reads_to_requested_window.sql'),
);
const stageMonotonicityMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_enforce_pipeline_stage_monotonicity.sql'),
);
const reviewScopeLookupMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_bound_pipeline_review_scope_lookup.sql'),
);
const clusterContextMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_bound_pipeline_cluster_context.sql'),
);
const persistenceInputBoundMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_bound_pipeline_persistence_inputs.sql'),
);
const accountPrivacyMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_finalize_account_privacy_and_public_apps.sql'),
);

assert.ok(hardeningMigrationName, 'internal RPC hardening migration must exist');
assert.ok(latestRunMigrationName, 'latest-run public read migration must exist');
assert.ok(optimizedRlsMigrationName, 'pipeline job RLS optimization migration must exist');
assert.ok(stabilizationMigrationName, 'pipeline stabilization migration must exist');
assert.ok(stabilizationFixMigrationName, 'pipeline stabilization runtime fix migration must exist');
assert.ok(enqueuePrepareMigrationName, 'pipeline job enqueue prepare migration must exist');
assert.ok(enqueueHardenMigrationName, 'pipeline job enqueue hardening migration must exist');
assert.ok(issueWindowMigrationName, 'requested-window public issue migration must exist');
assert.ok(stageMonotonicityMigrationName, 'pipeline stage monotonicity migration must exist');
assert.ok(reviewScopeLookupMigrationName, 'bounded pipeline review scope lookup migration must exist');
assert.ok(clusterContextMigrationName, 'bounded pipeline cluster context migration must exist');
assert.ok(persistenceInputBoundMigrationName, 'bounded pipeline persistence input migration must exist');
assert.ok(accountPrivacyMigrationName, 'account privacy and public app directory migration must exist');
assert.ok(
  enqueuePrepareMigrationName < enqueueHardenMigrationName,
  'pipeline job enqueue prepare migration must sort before hardening',
);
assert.ok(
  enqueuePrepareMigrationName < accountPrivacyMigrationName
    && accountPrivacyMigrationName < enqueueHardenMigrationName,
  'Worker expand migrations must sort before enqueue hardening',
);
const hardeningMigration = readFileSync(`supabase/migrations/${hardeningMigrationName}`, 'utf8');
const latestRunMigration = readFileSync(`supabase/migrations/${latestRunMigrationName}`, 'utf8');
const optimizedRlsMigration = readFileSync(`supabase/migrations/${optimizedRlsMigrationName}`, 'utf8');
const stabilizationMigration = readFileSync(`supabase/migrations/${stabilizationMigrationName}`, 'utf8');
const stabilizationFixMigration = readFileSync(`supabase/migrations/${stabilizationFixMigrationName}`, 'utf8');
const enqueuePrepareMigration = readFileSync(`supabase/migrations/${enqueuePrepareMigrationName}`, 'utf8');
const enqueueHardenMigration = readFileSync(`supabase/migrations/${enqueueHardenMigrationName}`, 'utf8');
const issueWindowMigration = readFileSync(`supabase/migrations/${issueWindowMigrationName}`, 'utf8');
const stageMonotonicityMigration = readFileSync(
  `supabase/migrations/${stageMonotonicityMigrationName}`,
  'utf8',
);
const reviewScopeLookupMigration = readFileSync(
  `supabase/migrations/${reviewScopeLookupMigrationName}`,
  'utf8',
);
const clusterContextMigration = readFileSync(
  `supabase/migrations/${clusterContextMigrationName}`,
  'utf8',
);
const persistenceInputBoundMigration = readFileSync(
  `supabase/migrations/${persistenceInputBoundMigrationName}`,
  'utf8',
);
const accountPrivacyMigration = readFileSync(
  `supabase/migrations/${accountPrivacyMigrationName}`,
  'utf8',
);

function extractLatestFunction(source, functionName) {
  const start = source.toLowerCase().lastIndexOf(`create or replace function public.${functionName.toLowerCase()}(`);
  assert.notEqual(start, -1, `missing function ${functionName}`);
  const end = source.indexOf('\n$$;', start);
  assert.notEqual(end, -1, `unterminated function ${functionName}`);
  return source.slice(start, end + 4);
}

test('schema embeds the stabilization migration without drift', () => {
  const marker = '-- Queue leases, claim fencing, and atomic pipeline persistence.';
  const nextMarker = '-- Scope issue counts and evidence to the same review window used by the';
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema stabilization marker must exist');
  assert.ok(end > start, 'schema requested-window marker must follow stabilization');
  assert.equal(schema.slice(start, end).trimEnd(), stabilizationMigration.trimEnd());
});

test('schema embeds the requested-window public issue migration without drift', () => {
  const marker = '-- Scope issue counts and evidence to the same review window used by the';
  const nextMarker = '-- Keep late heartbeats from moving a running pipeline job back to an earlier stage.';
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema requested-window marker must exist');
  assert.ok(end > start, 'schema stage monotonicity marker must follow requested-window migration');
  assert.equal(schema.slice(start, end).trimEnd(), issueWindowMigration.trimEnd());
});

test('schema embeds the pipeline stage monotonicity migration without drift', () => {
  const marker = '-- Keep late heartbeats from moving a running pipeline job back to an earlier stage.';
  const nextMarker = '-- Resolve up to the pipeline input cap in one service-role RPC.';
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema stage monotonicity marker must exist');
  assert.ok(end > start, 'schema review scope lookup marker must follow stage monotonicity');
  assert.equal(schema.slice(start, end).trimEnd(), stageMonotonicityMigration.trimEnd());
});

test('schema embeds the bounded pipeline review scope lookup migration without drift', () => {
  const marker = '-- Resolve up to the pipeline input cap in one service-role RPC.';
  const nextMarker = "-- Return each cluster's latest valid published identity as one bounded JSON";
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema review scope lookup marker must exist');
  assert.ok(end > start, 'schema cluster context marker must follow review scope lookup');
  assert.equal(schema.slice(start, end).trimEnd(), reviewScopeLookupMigration.trimEnd());
});

for (const [name, source] of [
  ['schema', schema],
  ['bounded review scope lookup migration', reviewScopeLookupMigration],
]) {
  test(`${name} keeps the bounded review scope lookup scalar and service-role only`, () => {
    const lookupSql = extractLatestFunction(source, 'get_pipeline_review_scope');
    assert.match(lookupSql, /returns jsonb/i);
    assert.match(lookupSql, /requested_count > 10000/i);
    assert.match(lookupSql, /jsonb_agg\([\s\S]*?order by requested\.ordinality/i);
    assert.match(lookupSql, /where not p_include_analysis or analysis\.review_id is not null/i);
    assert.match(
      source,
      /revoke execute on function public\.get_pipeline_review_scope\(text, text, text\[\], boolean\)\s+from public, anon, authenticated;/i,
    );
    assert.match(
      source,
      /grant execute on function public\.get_pipeline_review_scope\(text, text, text\[\], boolean\)\s+to service_role;/i,
    );
  });
}

test('schema embeds the bounded pipeline cluster context migration without drift', () => {
  const marker = "-- Return each cluster's latest valid published identity as one bounded JSON";
  const nextMarker = '-- Expand: let the service-role Worker enqueue jobs before authenticated';
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema bounded cluster context marker must exist');
  assert.ok(end > start, 'schema user job quota marker must follow bounded cluster context');
  assert.equal(schema.slice(start, end).trimEnd(), clusterContextMigration.trimEnd());
});

for (const [name, source] of [
  ['schema', schema],
  ['bounded pipeline cluster context migration', clusterContextMigration],
]) {
  test(`${name} returns every bounded latest valid cluster identity as service-role JSON`, () => {
    const contextSql = extractLatestFunction(source, 'get_pipeline_cluster_context_v2');
    assert.match(contextSql, /returns jsonb/i);
    assert.match(contextSql, /context_count > 10000/i);
    assert.match(contextSql, /partition by snapshot\.cluster_id/i);
    assert.match(contextSql, /pipeline_run\.status = 'published'/i);
    assert.match(contextSql, /pipeline_run\.validation_status = 'passed'/i);
    assert.match(contextSql, /snapshot\.validation_status = 'passed'/i);
    assert.match(contextSql, /left\(snapshot\.summary, 400\) as summary/i);
    assert.equal(
      (contextSql.match(/pipeline_run\.app_store_id = cluster\.app_store_id[\s\S]{0,100}?pipeline_run\.country = cluster\.country/gi) || []).length,
      2,
      'both bounded-context queries must reject cross-app run/snapshot contamination',
    );
    assert.match(contextSql, /jsonb_agg\([\s\S]*?'summary', context\.summary/i);
    assert.doesNotMatch(contextSql, /limit\s+100\s*;/i);
    assert.doesNotMatch(contextSql, /latest_run_id/i);
    assert.match(
      source,
      /revoke execute on function public\.get_pipeline_cluster_context_v2\(text, text\)\s+from public, anon, authenticated;/i,
    );
    assert.match(
      source,
      /grant execute on function public\.get_pipeline_cluster_context_v2\(text, text\)\s+to service_role;/i,
    );
  });
}

test('schema embeds the expanded enqueue prepare migration without drift', () => {
  const marker = '-- Expand: let the service-role Worker enqueue jobs before authenticated';
  const nextMarker = '-- Reject empty or oversized signed persistence payloads before claim renewal.';
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema enqueue prepare marker must exist');
  assert.ok(end > start, 'schema persistence input bound marker must follow user quota');
  assert.equal(schema.slice(start, end).trimEnd(), enqueuePrepareMigration.trimEnd());
});

for (const [name, source] of [
  ['schema', schema],
  ['pipeline job enqueue prepare migration', enqueuePrepareMigration],
]) {
  test(`${name} enqueues web jobs atomically behind a race-safe per-user quota`, () => {
    const enqueueSql = extractLatestFunction(source, 'enqueue_pipeline_job');
    assert.match(enqueueSql, /returns jsonb[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, public/i);
    assert.match(enqueueSql, /normalized_app_store_id !~ '\^\[0-9\]\{5,20\}\$'/i);
    assert.match(enqueueSql, /pg_advisory_xact_lock\([\s\S]*?queue:user:[\s\S]*?p_requested_by/i);
    assert.match(enqueueSql, /pg_advisory_xact_lock\([\s\S]*?queue:app:[\s\S]*?normalized_app_store_id/i);
    assert.ok(
      enqueueSql.indexOf("'result', 'existing'") < enqueueSql.indexOf('select count(*)::integer'),
      'active jobs must return before quota accounting',
    );
    assert.match(
      enqueueSql,
      /where pj\.requested_by = p_requested_by[\s\S]*?pj\.source = 'web'[\s\S]*?pj\.requested_at >= quota_now - interval '24 hours'/i,
    );
    assert.doesNotMatch(
      enqueueSql.slice(enqueueSql.indexOf('select count(*)::integer'), enqueueSql.indexOf("if recent_job_count >= effective_daily_limit")),
      /pj\.status/i,
      'terminal web jobs must remain in quota accounting',
    );
    assert.match(
      enqueueSql,
      /order by pj\.requested_at asc, pj\.id asc[\s\S]*?offset greatest\(recent_job_count - effective_daily_limit, 0\)[\s\S]*?limit 1/i,
    );
    assert.ok(
      enqueueSql.indexOf('if recent_job_count >= effective_daily_limit')
        < enqueueSql.indexOf('insert into public.apps'),
      'quota rejection must happen before app metadata is written',
    );
    assert.match(enqueueSql, /if normalized_app_name is null[\s\S]*?on conflict \(app_store_id, country\) do nothing/i);
    assert.match(enqueueSql, /insert into public\.pipeline_jobs[\s\S]*?'web'[\s\S]*?p_requested_by[\s\S]*?quota_now/i);
    assert.match(enqueueSql, /exception[\s\S]*?when unique_violation[\s\S]*?'result', 'existing'/i);
    assert.doesNotMatch(enqueueSql, /'(?:note|source)',\s*(?:active_job|created_job)\.(?:note|source)/i);
    assert.match(source, /create index if not exists idx_pipeline_jobs_web_user_requested_at/i);
    assert.match(
      source,
      /revoke execute on function public\.enqueue_pipeline_job\(text, text, text, text, uuid, integer\)[\s\S]*?from public, anon, authenticated;/i,
    );
    assert.match(
      source,
      /grant execute on function public\.enqueue_pipeline_job\(text, text, text, text, uuid, integer\)[\s\S]*?to service_role;/i,
    );
  });
}

test('pipeline job enqueue prepare migration stays additive for the previous service-role Worker', () => {
  assert.doesNotMatch(enqueuePrepareMigration, /revoke\s+insert\s+on\s+table\s+public\.pipeline_jobs/i);
  assert.doesNotMatch(enqueuePrepareMigration, /drop\s+(?:function|index|table|policy)/i);
});

test('schema embeds the bounded pipeline persistence input migration without drift', () => {
  const marker = '-- Reject empty or oversized signed persistence payloads before claim renewal.';
  const nextMarker = '-- Keep account deletion private-data cleanup atomic and bound the public app';
  const start = schema.lastIndexOf(marker);
  const end = schema.lastIndexOf(nextMarker);
  assert.notEqual(start, -1, 'schema persistence input bound marker must exist');
  assert.ok(end > start, 'schema account privacy marker must follow persistence input bounds');
  assert.equal(schema.slice(start, end).trimEnd(), persistenceInputBoundMigration.trimEnd());
});

test('schema embeds the account privacy and public app directory migration without drift', () => {
  const marker = '-- Keep account deletion private-data cleanup atomic and bound the public app';
  const start = schema.lastIndexOf(marker);
  assert.notEqual(start, -1, 'schema account privacy marker must exist');
  assert.equal(schema.slice(start).trimEnd(), accountPrivacyMigration.trimEnd());
});

for (const [name, source] of [
  ['schema', schema],
  ['account privacy migration', accountPrivacyMigration],
]) {
  test(`${name} prepares account deletion atomically and scrubs owner-readable text`, () => {
    const guardSql = extractLatestFunction(source, 'guard_pipeline_job_transition');
    const prepareSql = extractLatestFunction(source, 'prepare_account_deletion');
    const completeSql = extractLatestFunction(source, 'complete_pipeline_job');

    assert.match(
      guardSql,
      /old\.requested_by is not null[\s\S]*?new\.requested_by is null[\s\S]*?new\.note := null/i,
      'Auth FK owner removal must scrub late notes in the same update',
    );
    assert.match(
      guardSql,
      /old\.note is not null[\s\S]*?new\.note is null[\s\S]*?to_jsonb\(new\) - 'note'/i,
    );
    assert.match(guardSql, /terminal pipeline job is immutable/i);
    assert.match(
      source,
      /requested_by is null[\s\S]*?source = 'web'[\s\S]*?note is not null/i,
      'orphaned web notes from accounts deleted before the migration must be removed',
    );
    assert.doesNotMatch(
      source,
      /requested_by is null[\s\S]{0,120}?source = 'reanalysis'[\s\S]{0,120}?set note = null/i,
    );

    assert.match(prepareSql, /security definer[\s\S]*?set search_path = pg_catalog, public/i);
    assert.match(prepareSql, /pg_advisory_xact_lock\([\s\S]*?voc-radar:queue:user:/i);
    assert.ok(
      prepareSql.indexOf('public.cancel_pipeline_jobs') < prepareSql.indexOf('set note = null'),
      'active jobs must terminalize before terminal notes are redacted',
    );
    assert.match(prepareSql, /where pj\.requested_by = p_requested_by[\s\S]*?pj\.note is not null/i);
    assert.match(prepareSql, /get diagnostics redacted_count = row_count/i);

    assert.match(
      completeSql,
      /trim\(coalesce\(p_error_message, ''\)\) = 'review_scope_incomplete'[\s\S]*?then 'review_scope_incomplete'/i,
    );
    assert.match(completeSql, /when normalized_status = 'failed' then 'The analysis failed\. Retry the request\.'/i);
    assert.doesNotMatch(completeSql, /error_message\s*=\s*p_error_message/i);
    assert.match(
      source,
      /update public\.pipeline_jobs as job[\s\S]*?The analysis failed\. Retry the request\.[\s\S]*?where job\.status in \('completed', 'failed', 'canceled'\)/i,
      'legacy terminal errors must be reduced to safe values',
    );

    assert.match(
      source,
      /revoke all on function public\.prepare_account_deletion\(uuid\) from public, anon, authenticated, service_role;/i,
    );
    assert.match(source, /grant execute on function public\.prepare_account_deletion\(uuid\) to service_role;/i);
  });

  test(`${name} returns the exact latest published app directory in one bounded RPC`, () => {
    const directorySql = extractLatestFunction(source, 'get_public_apps');
    assert.match(
      source,
      /create index if not exists idx_pipeline_runs_public_app_directory[\s\S]*?app_store_id[\s\S]*?country[\s\S]*?published_at desc nulls last[\s\S]*?executed_at desc nulls last[\s\S]*?updated_at desc[\s\S]*?run_id desc[\s\S]*?where status = 'published' and review_count > 0/i,
    );
    assert.match(directorySql, /language sql[\s\S]*?stable[\s\S]*?security definer/i);
    assert.match(directorySql, /distinct on \(run\.app_store_id, run\.country\)/i);
    assert.match(directorySql, /run\.status = 'published'[\s\S]*?run\.review_count > 0/i);
    assert.match(
      directorySql,
      /left join public\.apps as app[\s\S]*?app\.app_store_id = latest\.app_store_id[\s\S]*?app\.country = latest\.country/i,
    );
    assert.match(directorySql, /limit least\(greatest\(coalesce\(p_limit, 20\), 1\), 100\)/i);
    assert.match(
      source,
      /revoke all on function public\.get_public_apps\(integer\) from public, anon, authenticated, service_role;/i,
    );
    assert.match(source, /grant execute on function public\.get_public_apps\(integer\) to service_role;/i);
  });
}

for (const [name, source] of [
  ['schema', schema],
  ['bounded pipeline persistence input migration', persistenceInputBoundMigration],
]) {
  test(`${name} rejects review persistence outside the signed input contract`, () => {
    const persistSql = extractLatestFunction(source, 'persist_pipeline_reviews');
    assert.match(persistSql, /review_total := jsonb_array_length/i);
    assert.match(
      persistSql,
      /if review_total < 1 or review_total > 10000 then[\s\S]*?errcode = '22023'/i,
    );
    assert.ok(
      persistSql.indexOf('if review_total < 1 or review_total > 10000')
        < persistSql.indexOf('from public.renew_pipeline_job_claim'),
      'review count bounds must reject before the claim is renewed',
    );
    assert.match(
      source,
      /revoke execute on function public\.persist_pipeline_reviews\(uuid, uuid, text, text, text, text, text, jsonb\)[\s\S]*?from public, anon, authenticated;/i,
    );
    assert.match(
      source,
      /grant execute on function public\.persist_pipeline_reviews\(uuid, uuid, text, text, text, text, text, jsonb\)[\s\S]*?to service_role;/i,
    );
  });

  test(`${name} rejects cluster and membership persistence outside the signed input contract`, () => {
    const persistSql = extractLatestFunction(source, 'persist_issue_clusters');
    assert.match(persistSql, /jsonb_typeof\(coalesce\(p_clusters, '\[\]'::jsonb\)\) <> 'array'/i);
    assert.match(
      persistSql,
      /jsonb_typeof\(cluster_payload\.payload->'review_ids'\) is distinct from 'array'/i,
    );
    assert.match(
      persistSql,
      /clusters_total < 1 or clusters_total > 10000[\s\S]*?input_memberships_total < 1 or input_memberships_total > 10000/i,
    );
    assert.ok(
      persistSql.indexOf('if clusters_total < 1 or clusters_total > 10000')
        < persistSql.indexOf('from public.renew_pipeline_job_claim'),
      'cluster and membership bounds must reject before the claim is renewed',
    );
    assert.match(
      source,
      /revoke execute on function public\.persist_issue_clusters\(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb\)[\s\S]*?from public, anon, authenticated;/i,
    );
    assert.match(
      source,
      /grant execute on function public\.persist_issue_clusters\(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb\)[\s\S]*?to service_role;/i,
    );
  });
}

test('pipeline job enqueue prepare migration is service-role-only additive expansion', () => {
  assert.match(enqueuePrepareMigration, /grant insert on table public\.pipeline_jobs to service_role;/i);
  assert.doesNotMatch(
    enqueuePrepareMigration,
    /drop policy if exists pipeline_jobs_insert_authenticated|revoke insert on table public\.pipeline_jobs/i,
  );
  const serviceRoleSmoke = enqueuePrepareFixture.slice(enqueuePrepareFixture.indexOf('set role service_role;'));
  assert.match(serviceRoleSmoke, /public\.enqueue_pipeline_job\(/i);
  assert.match(serviceRoleSmoke, /enqueue_result ->> 'result' <> 'queued'/i);
  assert.match(serviceRoleSmoke, /requested_by[\s\S]*?attempt_count = 0/i);
  assert.doesNotMatch(serviceRoleSmoke, /insert into public\.pipeline_jobs/i);
});

test('pipeline job enqueue hardening migration only contracts authenticated inserts', () => {
  assert.match(
    enqueueHardenMigration,
    /drop policy if exists pipeline_jobs_insert_authenticated on public\.pipeline_jobs;/i,
  );
  assert.match(
    enqueueHardenMigration,
    /revoke insert on table public\.pipeline_jobs from public, anon, authenticated;/i,
  );
  assert.doesNotMatch(enqueueHardenMigration, /grant insert on table public\.pipeline_jobs to service_role;/i);
});

test('canonical schema keeps pipeline job inserts behind the Worker service role', () => {
  assert.match(schema, /drop policy if exists pipeline_jobs_insert_authenticated on public\.pipeline_jobs;/i);
  assert.match(schema, /revoke insert on table public\.pipeline_jobs from public, anon, authenticated;/i);
  assert.match(schema, /grant insert on table public\.pipeline_jobs to service_role;/i);
  assert.doesNotMatch(
    schema,
    /grant\s+[^;]*\binsert\b[^;]*\bon\s+(?:table\s+)?public\.pipeline_jobs\s+to\s+authenticated\s*;/i,
  );
});

const legacyInternalFunctions = [
  'get_existing_review_ids\\(text, text, text\\[\\]\\)',
  'claim_pipeline_job\\(text, text, text\\)',
  'complete_pipeline_job\\(uuid, text, text, text\\)',
];

test('historical hardening migration keeps legacy pipeline RPCs service-role only', () => {
  for (const signature of legacyInternalFunctions) {
    assert.match(
      hardeningMigration,
      new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated;`, 'i'),
    );
    assert.match(
      hardeningMigration,
      new RegExp(`grant execute on function public\\.${signature}\\s+to service_role;`, 'i'),
    );
  }
});

const fencedInternalFunctions = [
  'claim_pipeline_job\\(text, text, text, text\\)',
  'renew_pipeline_job_claim\\(uuid, uuid, text, text\\)',
  'complete_pipeline_job\\(uuid, uuid, text, text, text, text\\)',
  'cancel_pipeline_jobs\\(uuid, uuid, boolean, text, text, text\\)',
  'persist_pipeline_reviews\\(uuid, uuid, text, text, text, text, text, jsonb\\)',
  'persist_issue_clusters\\(uuid, uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, jsonb\\)',
  'publish_pipeline_run\\(uuid, uuid, text, text, text, timestamptz\\)',
  'persist_pipeline_alerts\\(uuid, uuid, text, text, text, jsonb\\)',
  'record_pipeline_parse_error\\(uuid, uuid, text, text, text, text, text, text\\)',
  'get_pipeline_cluster_context\\(text, text\\)',
];

test('schema keeps the unchanged review lookup RPC service-role only', () => {
  const signature = 'get_existing_review_ids\\(text, text, text\\[\\]\\)';
  assert.match(
    schema,
    new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated;`, 'i'),
  );
  assert.match(schema, new RegExp(`grant execute on function public\\.${signature}\\s+to service_role;`, 'i'));
});

for (const [name, source] of [
  ['schema', schema],
  ['pipeline stabilization migration', stabilizationMigration],
]) {
  test(`${name} keeps fenced pipeline SECURITY DEFINER RPCs service-role only`, () => {
    for (const signature of fencedInternalFunctions) {
      assert.match(
        source,
        new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated;`, 'i'),
      );
      assert.match(source, new RegExp(`grant execute on function public\\.${signature}\\s+to service_role;`, 'i'));
    }

    assert.doesNotMatch(
      source,
      /grant execute on function public\.get_existing_review_ids\([^)]+\)\s+to anon/i,
    );
  });
}

for (const [name, source] of [
  ['schema', schema],
  ['pipeline stabilization migration', stabilizationMigration],
  ['pipeline stabilization runtime fix migration', stabilizationFixMigration],
]) {
  test(`${name} avoids PL/pgSQL output-column ambiguity and covers the staging FK`, () => {
    const persistReviewsSql = extractLatestFunction(source, 'persist_pipeline_reviews');
    const persistClustersSql = extractLatestFunction(source, 'persist_issue_clusters');
    const parseErrorSql = extractLatestFunction(source, 'record_pipeline_parse_error');

    assert.match(persistReviewsSql, /on conflict on constraint pipeline_runs_run_id_key/i);
    assert.match(persistReviewsSql, /on conflict on constraint pipeline_review_ai_staging_pkey/i);
    assert.match(
      persistClustersSql,
      /delete from public\.issue_cluster_reviews as membership where membership\.run_id = p_run_id/i,
    );
    assert.match(
      persistClustersSql,
      /delete from public\.issue_cluster_snapshots as snapshot where snapshot\.run_id = p_run_id/i,
    );
    assert.match(parseErrorSql, /on conflict on constraint parse_errors_parse_error_id_key/i);
    assert.match(
      source,
      /idx_pipeline_review_ai_staging_review_scope[\s\S]*?\(review_id, app_store_id, country\)/i,
    );

    assert.doesNotMatch(persistReviewsSql, /on conflict\s*\(\s*run_id/i);
    assert.doesNotMatch(persistClustersSql, /where\s+run_id\s*=\s*p_run_id/i);
    assert.doesNotMatch(parseErrorSql, /on conflict\s*\(\s*parse_error_id/i);
  });
}

for (const [name, source] of [
  ['schema', schema.slice(schema.lastIndexOf('-- Queue leases, claim fencing'))],
  ['pipeline stabilization migration', stabilizationMigration],
]) {
  test(`${name} can replace already-removed legacy queue RPCs`, () => {
    assert.match(source, /drop function if exists public\.claim_pipeline_job\(text, text, text\)/i);
    assert.match(source, /drop function if exists public\.complete_pipeline_job\(uuid, text, text, text\)/i);
    assert.doesNotMatch(source, /revoke execute on function public\.claim_pipeline_job\(text, text, text\)/i);
    assert.doesNotMatch(source, /revoke execute on function public\.complete_pipeline_job\(uuid, text, text, text\)/i);
  });
}

for (const [name, source] of [
  ['schema', schema],
  ['hardening migration', hardeningMigration],
]) {
  test(`${name} covers V2 foreign-key lookup indexes`, () => {
    assert.match(source, /idx_issue_cluster_reviews_review\s+on public\.issue_cluster_reviews \(review_id\)/i);
    assert.match(source, /idx_issue_clusters_current_run\s+on public\.issue_clusters \(current_run_id\)/i);
  });
}

for (const [name, source] of [
  ['schema', schema],
  ['pipeline stabilization migration', stabilizationMigration],
]) {
  test(`${name} preserves queue lease, terminal, and account-deletion invariants`, () => {
    assert.match(source, /claim_key text/i);
    assert.match(source, /claim_token uuid/i);
    assert.match(source, /lease_expires_at timestamptz/i);
    assert.match(source, /last_heartbeat_at timestamptz/i);
    assert.match(source, /attempt_count integer not null default 0/i);
    assert.match(source, /interval '15 minutes'/i);
    assert.match(source, /expired_job\.attempt_count >= 3[\s\S]*?status = 'failed'/i);
    assert.match(source, /expired_job\.attempt_count < 3[\s\S]*?status = 'queued'/i);
    assert.match(source, /create table if not exists public\.pipeline_job_claims/i);
    assert.match(source, /old\.status in \('completed', 'failed', 'canceled'\)/i);
    assert.match(source, /old\.requested_by is not null[\s\S]*?to_jsonb\(new\) - 'requested_by'/i);
    assert.match(source, /cluster review scope mismatch/i);
    const claimSql = extractLatestFunction(source, 'claim_pipeline_job');
    const cancelSql = extractLatestFunction(source, 'cancel_pipeline_jobs');
    const completeSql = extractLatestFunction(source, 'complete_pipeline_job');
    assert.match(
      claimSql,
      /for expired_job in[\s\S]*?from public\.pipeline_jobs as pj[\s\S]*?order by pj\.id asc[\s\S]*?for update of pj skip locked[\s\S]*?loop/i,
    );
    assert.ok(
      claimSql.toLowerCase().indexOf('for update of pj skip locked')
        < claimSql.toLowerCase().indexOf('update public.pipeline_runs as pr'),
      'expired recovery must lock the job before the run',
    );
    assert.match(
      cancelSql,
      /from public\.pipeline_jobs as pj[\s\S]*?order by pj\.id asc[\s\S]*?for update/i,
      'bulk cancellation must use the same job-id lock order',
    );
    assert.match(
      completeSql,
      /normalized_status = 'completed'[\s\S]*?pipeline_review_ai_staging[\s\S]*?pr\.status <> 'published'[\s\S]*?pr\.app_store_id <> current_job\.app_store_id[\s\S]*?pr\.country <> current_job\.country[\s\S]*?errcode = '23514'/i,
      'direct completion must reject staged or unpublished runs',
    );
  });

  test(`${name} keeps pipeline persistence and publication transactional`, () => {
    for (const functionName of [
      'persist_pipeline_reviews',
      'persist_issue_clusters',
      'publish_pipeline_run',
      'persist_pipeline_alerts',
      'record_pipeline_parse_error',
    ]) {
      assert.match(source, new RegExp(`create or replace function public\\.${functionName}\\(`, 'i'));
    }
    assert.match(source, /perform 1[\s\S]*?public\.complete_pipeline_job\([\s\S]*?'completed'/i);
    assert.match(source, /add column if not exists title text,[\s\S]*?add column if not exists model_version text/i);
    assert.match(source, /select c\.id, s\.title, s\.category[\s\S]*?s\.model_version/i);
    const persistReviewsSql = extractLatestFunction(source, 'persist_pipeline_reviews');
    const publishSql = extractLatestFunction(source, 'publish_pipeline_run');
    const existingIdsSql = extractLatestFunction(source, 'get_existing_review_ids');
    const reviewsPolicyStart = source.toLowerCase().lastIndexOf('create policy reviews_read_authenticated');
    assert.notEqual(reviewsPolicyStart, -1, 'committed review policy must exist');
    const reviewsPolicySql = source.slice(reviewsPolicyStart, source.indexOf(';', reviewsPolicyStart) + 1);
    assert.match(source, /create table if not exists public\.pipeline_review_ai_staging/i);
    assert.match(source, /alter table public\.pipeline_review_ai_staging enable row level security/i);
    assert.match(source, /revoke all on table public\.pipeline_review_ai_staging from public, anon, authenticated/i);
    assert.match(
      reviewsPolicySql,
      /for select to authenticated[\s\S]*?using \([\s\S]*?exists \([\s\S]*?from public\.review_ai as committed_ai[\s\S]*?committed_ai\.review_id = reviews\.review_id/i,
    );
    assert.doesNotMatch(reviewsPolicySql, /to anon|using \(true\)/i);
    assert.doesNotMatch(source, /grant select on (table )?public\.reviews to anon/i);
    assert.match(
      persistReviewsSql,
      /join public\.reviews as existing[\s\S]*?existing\.app_store_id <> p_app_store_id[\s\S]*?existing\.country <> normalized_country[\s\S]*?errcode = '23514'/i,
    );
    assert.ok(
      persistReviewsSql.indexOf('review already belongs to another app scope')
        < persistReviewsSql.indexOf('insert into public.pipeline_runs'),
      'cross-app conflict must abort before persistence',
    );
    assert.match(persistReviewsSql, /insert into public\.pipeline_review_ai_staging/i);
    assert.doesNotMatch(persistReviewsSql, /insert into public\.review_ai\s*\(/i);
    assert.match(persistReviewsSql, /values \(p_app_store_id, normalized_country, null, now\(\)\)/i);
    assert.match(persistReviewsSql, /on conflict \(review_id\) do nothing/i);
    assert.match(
      persistReviewsSql,
      /on conflict \(review_id\) do nothing;[\s\S]*?left join public\.reviews as persisted[\s\S]*?review scope changed during persistence[\s\S]*?insert into public\.pipeline_review_ai_staging/i,
    );
    assert.match(
      persistReviewsSql,
      /group by incoming\.review_id[\s\S]*?count\(\*\) > 1[\s\S]*?errcode = '23514'[\s\S]*?review ids must be nonempty and unique/i,
    );
    assert.match(source, /create unique index if not exists uq_reviews_id_scope[\s\S]*?review_id, app_store_id, country/i);
    assert.match(
      source,
      /foreign key \(review_id, app_store_id, country\)[\s\S]*?references public\.reviews \(review_id, app_store_id, country\)/i,
    );
    for (const column of ['rating', 'author', 'content', 'reviewed_at', 'raw_source']) {
      assert.match(
        persistReviewsSql,
        new RegExp(`insert into public\\.pipeline_review_ai_staging[\\s\\S]*?${column}`, 'i'),
      );
    }
    assert.match(existingIdsSql, /join public\.review_ai as ai/i);
    assert.doesNotMatch(existingIdsSql, /pipeline_review_ai_staging/i);
    assert.match(publishSql, /insert into public\.review_ai[\s\S]*?from public\.pipeline_review_ai_staging/i);
    assert.match(
      publishSql,
      /update public\.reviews as review[\s\S]*?rating = staging\.rating[\s\S]*?raw_source = staging\.raw_source[\s\S]*?insert into public\.review_ai/i,
    );
    assert.ok(
      publishSql.indexOf('insert into public.review_ai') < publishSql.indexOf("set status = 'published'"),
      'AI merge and publication must be one transaction',
    );
    assert.match(publishSql, /update public\.apps as app[\s\S]*?job\.app_name/i);
    assert.doesNotMatch(source, /^\s*(commit|rollback)\b/im);
  });
}

test('schema evaluates auth.uid once for the remaining pipeline job read policy', () => {
  assert.match(schema, /using \(requested_by = \(select auth\.uid\(\)\)\)/i);
  assert.doesNotMatch(schema, /with check \(requested_by = \(select auth\.uid\(\)\)\)/i);
  assert.doesNotMatch(schema, /requested_by = auth\.uid\(\)/i);
});

test('pipeline job RLS optimization migration evaluates auth.uid once per statement', () => {
  assert.match(optimizedRlsMigration, /with check \(requested_by = \(select auth\.uid\(\)\)\)/i);
  assert.match(optimizedRlsMigration, /using \(requested_by = \(select auth\.uid\(\)\)\)/i);
  assert.doesNotMatch(optimizedRlsMigration, /requested_by = auth\.uid\(\)/i);
});

for (const [name, source] of [
  ['schema', schema],
  ['pipeline stage monotonicity migration', stageMonotonicityMigration],
]) {
  test(`${name} rejects regressive pipeline heartbeats before renewing the lease`, () => {
    const renewSql = extractLatestFunction(source, 'renew_pipeline_job_claim');
    assert.match(renewSql, /pipeline_stages constant text\[\][\s\S]*?'queued'[\s\S]*?'publishing'/i);
    assert.match(
      renewSql,
      /array_position\(pipeline_stages, p_stage\)\s*<\s*array_position\(pipeline_stages, current_job\.stage\)[\s\S]*?return;/i,
    );
    assert.ok(
      renewSql.indexOf('array_position(pipeline_stages, p_stage)')
        < renewSql.indexOf('update public.pipeline_jobs as pj'),
      'regressive stage check must run before the lease update',
    );
  });

  test(`${name} rejects regressive stage updates outside the heartbeat RPC`, () => {
    const triggerSql = extractLatestFunction(source, 'reject_pipeline_job_stage_regression');
    assert.match(
      triggerSql,
      /old\.status = 'running'[\s\S]*?new\.status = 'running'[\s\S]*?new\.stage is null[\s\S]*?array_position\(pipeline_stages, new\.stage\)[\s\S]*?<\s*array_position\(pipeline_stages, old\.stage\)/i,
    );
    assert.match(
      source,
      /create trigger pipeline_jobs_reject_stage_regression[\s\S]*?before update of status, stage on public\.pipeline_jobs[\s\S]*?execute function public\.reject_pipeline_job_stage_regression\(\)/i,
    );
  });
}

test('pipeline stage monotonicity migration remains service-role only', () => {
  const signature = 'renew_pipeline_job_claim\\(uuid, uuid, text, text\\)';
  assert.match(
    stageMonotonicityMigration,
    new RegExp(`revoke execute on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated;`, 'i'),
  );
  assert.match(
    stageMonotonicityMigration,
    new RegExp(`grant execute on function public\\.${signature}[\\s\\S]*?to service_role;`, 'i'),
  );
});

test('historical latest-run migration scopes both public issue RPCs to one published run', () => {
  const listSql = extractLatestFunction(latestRunMigration, 'get_public_issue_clusters');
  const detailSql = extractLatestFunction(latestRunMigration, 'get_public_issue_detail');
  assert.match(listSql, /with latest_run as \([\s\S]*?status = 'published'[\s\S]*?validation_status = 'passed'/i);
  assert.match(listSql, /join public\.issue_cluster_snapshots s\s+on s\.run_id = latest_run\.run_id/i);
  assert.doesNotMatch(listSql, /join lateral \(/i);
  assert.match(detailSql, /with target_cluster as \([\s\S]*?latest_run as \(/i);
  assert.match(detailSql, /s\.cluster_id = c\.id\s+and s\.run_id = latest_run\.run_id/i);
});

test('historical latest-run migration retains its original public issue signatures', () => {
  for (const signature of ['get_public_issue_clusters\\(text, text, integer\\)', 'get_public_issue_detail\\(uuid\\)']) {
    assert.match(latestRunMigration, new RegExp(`revoke all on function public\\.${signature} from public;`, 'i'));
    assert.match(
      latestRunMigration,
      new RegExp(`grant execute on function public\\.${signature} to anon, authenticated;`, 'i'),
    );
  }
});

for (const [name, source] of [
  ['schema', schema],
  ['requested-window migration', issueWindowMigration],
]) {
  test(`${name} aggregates published issue evidence with one current membership per review`, () => {
    const listSql = extractLatestFunction(source, 'get_public_issue_clusters_windowed');
    const detailSql = extractLatestFunction(source, 'get_public_issue_detail_windowed');
    assert.match(listSql, /p_from timestamptz default null[\s\S]*?p_to timestamptz default null/i);
    assert.match(listSql, /bounds as \([\s\S]*?interval '29 days'[\s\S]*?interval '90 days'/i);
    assert.match(listSql, /scoped_memberships as \([\s\S]*?from bounds\s+cross join public\.issue_cluster_reviews cr/i);
    assert.match(listSql, /pr\.status = 'published'[\s\S]*?pr\.validation_status = 'passed'/i);
    assert.match(listSql, /pr\.app_store_id = c\.app_store_id[\s\S]*?pr\.country = c\.country/i);
    assert.match(listSql, /partition by cr\.review_id[\s\S]*?pr\.published_at desc/i);
    assert.match(listSql, /where membership\.membership_rank = 1/i);
    assert.match(listSql, /r\.reviewed_at >= bounds\.from_at/i);
    assert.match(listSql, /r\.reviewed_at <= bounds\.to_at/i);
    assert.match(listSql, /count\(\*\)::integer as review_count,[\s\S]*?max\(membership\.reviewed_at\)/i);
    assert.match(listSql, /ranked_snapshots as \([\s\S]*?partition by s\.cluster_id/i);
    assert.match(listSql, /p_from is null and p_to is null then s\.change_percent else null::numeric/i);
    assert.match(listSql, /count\(\*\) over\(\)::integer/i);
    assert.doesNotMatch(listSql, /with latest_run as/i);

    assert.match(detailSql, /p_issue_id uuid[\s\S]*?p_from timestamptz default null[\s\S]*?p_to timestamptz default null/i);
    assert.match(detailSql, /bounds as \([\s\S]*?interval '29 days'[\s\S]*?interval '90 days'/i);
    assert.match(detailSql, /scoped_memberships as \([\s\S]*?join public\.issue_cluster_reviews cr/i);
    assert.match(detailSql, /pr\.app_store_id = c\.app_store_id[\s\S]*?pr\.country = c\.country/i);
    assert.match(detailSql, /partition by cr\.review_id[\s\S]*?pr\.published_at desc/i);
    assert.match(detailSql, /membership\.membership_rank = 1[\s\S]*?membership\.cluster_id = p_issue_id/i);
    assert.match(detailSql, /r\.reviewed_at >= bounds\.from_at/i);
    assert.match(detailSql, /r\.reviewed_at <= bounds\.to_at/i);
    assert.match(detailSql, /count\(\*\)::integer as review_count, max\(reviewed_at\) as last_occurred_at/i);
    assert.match(detailSql, /bounded_reviews as \([\s\S]*?from windowed_reviews review[\s\S]*?limit 50/i);
    assert.match(detailSql, /from bounded_reviews review/i);
    assert.match(detailSql, /where evidence\.review_count > 0/i);
    assert.ok(
      detailSql.indexOf('), evidence as (') < detailSql.indexOf('), bounded_reviews as ('),
      'full evidence count must be computed before the detail payload limit',
    );
  });
}

test('canonical schema keeps windowed reads and rollback-compatible issue RPCs service-role only', () => {
  const issueWindowSchema = schema.slice(schema.lastIndexOf('-- Scope issue counts and evidence'));
  const listSignature = 'get_public_issue_clusters_windowed\\(text, text, integer, timestamptz, timestamptz\\)';
  const detailSignature = 'get_public_issue_detail_windowed\\(uuid, timestamptz, timestamptz\\)';
  assert.match(
    issueWindowSchema,
    new RegExp(`revoke all on function public\\.${listSignature}[\\s\\S]*?from public, anon, authenticated;`, 'i'),
  );
  assert.match(
    issueWindowSchema,
    new RegExp(`grant execute on function public\\.${listSignature}[\\s\\S]*?to service_role;`, 'i'),
  );
  assert.match(
    issueWindowSchema,
    new RegExp(`revoke all on function public\\.${detailSignature}[\\s\\S]*?from public, anon, authenticated;`, 'i'),
  );
  assert.match(
    issueWindowSchema,
    new RegExp(`grant execute on function public\\.${detailSignature}[\\s\\S]*?to service_role;`, 'i'),
  );
  for (const legacySignature of [
    'get_public_issue_clusters\\(text, text, integer\\)',
    'get_public_issue_detail\\(uuid\\)',
  ]) {
    assert.match(
      issueWindowSchema,
      new RegExp(`revoke all on function public\\.${legacySignature}[\\s\\S]*?from public, anon, authenticated;`, 'i'),
    );
    assert.match(
      issueWindowSchema,
      new RegExp(`grant execute on function public\\.${legacySignature}[\\s\\S]*?to service_role;`, 'i'),
    );
  }
  assert.doesNotMatch(issueWindowSchema, /to anon, authenticated;/i);
});
