import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWranglerDeployArgs,
  resolveDeploymentFlags,
} from './deploy-worker.mjs';

test('Worker deployment requires both observed feature-flag values', () => {
  assert.throws(
    () => resolveDeploymentFlags({ DETAIL_VIEW_ENABLED: 'true' }),
    /REPORT_V2_ENABLED must be explicitly set/,
  );
  assert.throws(
    () => resolveDeploymentFlags({ REPORT_V2_ENABLED: 'true', DETAIL_VIEW_ENABLED: 'yes' }),
    /DETAIL_VIEW_ENABLED must be explicitly set/,
  );
});

test('Worker deployment overrides fail-closed config with the observed live flags', () => {
  const args = buildWranglerDeployArgs({
    REPORT_V2_ENABLED: 'true',
    DETAIL_VIEW_ENABLED: 'false',
  });
  assert.deepEqual(args, [
    'deploy',
    '--config',
    'wrangler.toml',
    '--keep-vars',
    '--var',
    'REPORT_V2_ENABLED:true',
    '--var',
    'DETAIL_VIEW_ENABLED:false',
  ]);
});

test('Worker dry-run uses the same explicit feature-flag contract', () => {
  const args = buildWranglerDeployArgs({
    REPORT_V2_ENABLED: 'false',
    DETAIL_VIEW_ENABLED: 'true',
  }, { dryRun: true });
  assert.equal(args.at(-1), '--dry-run');
  assert.ok(args.includes('REPORT_V2_ENABLED:false'));
  assert.ok(args.includes('DETAIL_VIEW_ENABLED:true'));
});
