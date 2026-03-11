import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd(), '..', '..');
  const bootstrapSql = readFileSync(path.join(repoRoot, 'supabase/20260307_voc_radar_bootstrap.sql'), 'utf8');
  const workerSource = readFileSync(path.join(repoRoot, 'apps/worker/src/index.ts'), 'utf8');

  await test('private_review_feed view uses security_invoker to avoid security definer warnings', () => {
    assert.match(
      bootstrapSql,
      /create view public\.private_review_feed\s+with \(security_invoker = true\) as/i,
    );
  });

  await test('private_review_feed is not directly granted to authenticated users', () => {
    assert.doesNotMatch(
      bootstrapSql,
      /grant select on table public\.private_review_feed to authenticated;/i,
    );
  });

  await test('private review endpoint does not query private_review_feed with end-user JWT', () => {
    const privateHandlerStart = workerSource.indexOf('async function handlePrivateReviews');
    const internalHandlerStart = workerSource.indexOf('async function handleInternalUpsertReviews');
    assert.notEqual(privateHandlerStart, -1);
    assert.notEqual(internalHandlerStart, -1);

    const privateHandlerSource = workerSource.slice(privateHandlerStart, internalHandlerStart);
    assert.match(
      privateHandlerSource,
      /supabaseRequest<Array<Record<string, unknown>>>\(env, `\/rest\/v1\/private_review_feed\?\$\{filters\.toString\(\)\}`/,
    );
    assert.doesNotMatch(privateHandlerSource, /supabaseUserRequest<Array<Record<string, unknown>>>/);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
