import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

let workerModule;
let tempDir;
const testDir = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(testDir, '../index.ts');

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'voc-radar-worker-test-'));
  const outfile = join(tempDir, 'worker.mjs');

  await build({
    entryPoints: [workerEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
  });

  workerModule = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
});

test.after(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('scheduled keepalive performs multiple cheap Supabase GET probes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: init.headers,
    });

    return new Response('[]', {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  };

  try {
    assert.equal(typeof workerModule.default.scheduled, 'function');

    const pending = [];
    const ctx = {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    };

    await workerModule.default.scheduled(
      {
        cron: '0 3 * * *',
        scheduledTime: Date.now(),
      },
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key',
        PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
        API_TIMEOUT_MS: '50',
        API_RETRY_COUNT: '0',
      },
      ctx,
    );

    await Promise.all(pending);

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['GET', 'GET'],
    );
    assert.match(calls[0].url, /\/rest\/v1\/apps\?select=app_store_id&limit=1$/);
    assert.match(calls[1].url, /\/rest\/v1\/pipeline_runs\?select=run_id&limit=1$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
