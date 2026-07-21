import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const bootstrap = readFileSync('supabase/20260307_voc_radar_bootstrap.sql', 'utf8');
const hardeningMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_harden_internal_rpc_privileges.sql'),
);
const latestRunMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_scope_issue_list_to_latest_run.sql'),
);
const optimizedRlsMigrationName = readdirSync('supabase/migrations').find((name) =>
  name.endsWith('_optimize_pipeline_job_rls.sql'),
);

assert.ok(hardeningMigrationName, 'internal RPC hardening migration must exist');
assert.ok(latestRunMigrationName, 'latest-run public read migration must exist');
assert.ok(optimizedRlsMigrationName, 'pipeline job RLS optimization migration must exist');
const hardeningMigration = readFileSync(`supabase/migrations/${hardeningMigrationName}`, 'utf8');
const latestRunMigration = readFileSync(`supabase/migrations/${latestRunMigrationName}`, 'utf8');
const optimizedRlsMigration = readFileSync(`supabase/migrations/${optimizedRlsMigrationName}`, 'utf8');

const internalFunctions = [
  'get_existing_review_ids\\(text, text, text\\[\\]\\)',
  'claim_pipeline_job\\(text, text, text\\)',
  'complete_pipeline_job\\(uuid, text, text, text\\)',
];

for (const [name, source] of [
  ['bootstrap', bootstrap],
  ['hardening migration', hardeningMigration],
]) {
  test(`${name} keeps pipeline SECURITY DEFINER RPCs service-role only`, () => {
    for (const signature of internalFunctions) {
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

  test(`${name} covers V2 foreign-key lookup indexes`, () => {
    assert.match(source, /idx_issue_cluster_reviews_review\s+on public\.issue_cluster_reviews \(review_id\)/i);
    assert.match(source, /idx_issue_clusters_current_run\s+on public\.issue_clusters \(current_run_id\)/i);
  });
}

for (const [name, source] of [
  ['bootstrap', bootstrap],
  ['pipeline job RLS optimization migration', optimizedRlsMigration],
]) {
  test(`${name} evaluates auth.uid once per statement for pipeline job policies`, () => {
    assert.match(source, /with check \(requested_by = \(select auth\.uid\(\)\)\)/i);
    assert.match(source, /using \(requested_by = \(select auth\.uid\(\)\)\)/i);
    assert.doesNotMatch(source, /requested_by = auth\.uid\(\)/i);
  });
}

for (const [name, source] of [
  ['bootstrap', bootstrap],
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
