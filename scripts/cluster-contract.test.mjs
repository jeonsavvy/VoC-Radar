import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { validateClusterContract } from './cluster-contract.mjs';

const workerSource = await readFile(new URL('../apps/worker/src/cluster-contract.ts', import.meta.url), 'utf8');
const workerJavaScript = await transform(workerSource, { loader: 'ts', format: 'esm', target: 'es2022' });
const workerContract = await import(`data:text/javascript;base64,${Buffer.from(workerJavaScript.code).toString('base64')}`);
const validators = [validateClusterContract, workerContract.validateClusterContract];

const base = {
  extractions: [
    { reviewId: 'r1', category: '버그 및 성능', summary: '실행 실패' },
    { reviewId: 'r2', category: '버그 및 성능', summary: '로그인 크래시' },
  ],
  clusters: [{
    canonicalKey: 'startup-crash',
    title: '앱 실행 실패',
    category: '버그 및 성능',
    severity: 'high',
    summary: '앱이 시작 구간에서 종료된다.',
    reviewIds: ['r1', 'r2'],
  }],
};

test('accepts an exact one-cluster assignment', () => {
  for (const validate of validators) {
    const result = validate(['r1', 'r2'], base);
    assert.equal(result.validation.assignedReviewCount, 2);
  }
});

test('rejects hallucinated review ids', () => {
  const invalid = structuredClone(base);
  invalid.clusters[0].reviewIds = ['r1', 'not-a-review'];
  for (const validate of validators) {
    assert.throws(() => validate(['r1', 'r2'], invalid), /unknown cluster reviewId/);
  }
});

test('rejects duplicate assignments', () => {
  const invalid = structuredClone(base);
  invalid.clusters.push({ ...invalid.clusters[0], canonicalKey: 'other', reviewIds: ['r2'] });
  for (const validate of validators) {
    assert.throws(() => validate(['r1', 'r2'], invalid), /assigned more than once/);
  }
});
