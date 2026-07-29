import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const schema = readFileSync('supabase/schema.sql', 'utf8');
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

assert.ok(hardeningMigrationName, 'internal RPC hardening migration must exist');
assert.ok(latestRunMigrationName, 'latest-run public read migration must exist');
assert.ok(optimizedRlsMigrationName, 'pipeline job RLS optimization migration must exist');
assert.ok(stabilizationMigrationName, 'pipeline stabilization migration must exist');
assert.ok(stabilizationFixMigrationName, 'pipeline stabilization runtime fix migration must exist');
const hardeningMigration = readFileSync(`supabase/migrations/${hardeningMigrationName}`, 'utf8');
const latestRunMigration = readFileSync(`supabase/migrations/${latestRunMigrationName}`, 'utf8');
const optimizedRlsMigration = readFileSync(`supabase/migrations/${optimizedRlsMigrationName}`, 'utf8');
const stabilizationMigration = readFileSync(`supabase/migrations/${stabilizationMigrationName}`, 'utf8');
const stabilizationFixMigration = readFileSync(`supabase/migrations/${stabilizationFixMigrationName}`, 'utf8');

function extractLatestFunction(source, functionName) {
  const start = source.toLowerCase().lastIndexOf(`create or replace function public.${functionName.toLowerCase()}(`);
  assert.notEqual(start, -1, `missing function ${functionName}`);
  const end = source.indexOf('\n$$;', start);
  assert.notEqual(end, -1, `unterminated function ${functionName}`);
  return source.slice(start, end + 4);
}

test('schema embeds the stabilization migration without drift', () => {
  const marker = '-- Queue leases, claim fencing, and atomic pipeline persistence.';
  const start = schema.lastIndexOf(marker);
  assert.notEqual(start, -1, 'schema stabilization marker must exist');
  assert.equal(schema.slice(start), stabilizationMigration);
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

for (const [name, source] of [
  ['schema', schema],
  ['pipeline job RLS optimization migration', optimizedRlsMigration],
]) {
  test(`${name} evaluates auth.uid once per statement for pipeline job policies`, () => {
    assert.match(source, /with check \(requested_by = \(select auth\.uid\(\)\)\)/i);
    assert.match(source, /using \(requested_by = \(select auth\.uid\(\)\)\)/i);
    assert.doesNotMatch(source, /requested_by = auth\.uid\(\)/i);
  });
}

for (const [name, source] of [
  ['schema', schema],
  ['latest-run migration', latestRunMigration],
]) {
  test(`${name} scopes public issue reads to one latest published run`, () => {
    assert.match(source, /with latest_run as \([\s\S]*?status = 'published'[\s\S]*?validation_status = 'passed'/i);
    assert.match(source, /join public\.issue_cluster_snapshots s\s+on s\.run_id = latest_run\.run_id/i);
    assert.match(source, /with target_cluster as \([\s\S]*?latest_run as \(/i);
    assert.match(source, /s\.cluster_id = c\.id\s+and s\.run_id = latest_run\.run_id/i);
    assert.doesNotMatch(source, /join lateral \(/i);
  });

  test(`${name} exposes only the intended public issue RPCs`, () => {
    for (const signature of ['get_public_issue_clusters\\(text, text, integer\\)', 'get_public_issue_detail\\(uuid\\)']) {
      assert.match(source, new RegExp(`revoke all on function public\\.${signature} from public;`, 'i'));
      assert.match(source, new RegExp(`grant execute on function public\\.${signature} to anon, authenticated;`, 'i'));
    }
  });
}
