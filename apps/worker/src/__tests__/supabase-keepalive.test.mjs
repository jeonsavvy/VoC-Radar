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

test('review fetch falls back to the Apple storefront review-row endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      headers: new Headers(init.headers),
    });

    if (url.includes('/rss/customerreviews/')) {
      return new Response('', {
        status: 403,
      });
    }

    return new Response(
      JSON.stringify({
        userReviewList: [
          {
            userReviewId: 'review-1',
            body: '새 리뷰',
            date: new Date().toISOString(),
            name: 'reviewer',
            rating: 5,
          },
        ],
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  };

  try {
    const body = JSON.stringify({
      appStoreId: '1018769995',
      country: 'kr',
      windowDays: 30,
      maxPages: 1,
    });
    const request = new Request('https://worker.example/api/internal/pipeline/fetch-reviews', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-voc-token': 'pipeline-secret',
      },
      body,
    });

    const response = await workerModule.default.fetch(request, {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_ANON_KEY: 'anon-key',
      PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
      API_TIMEOUT_MS: '50',
      API_RETRY_COUNT: '0',
    });

    const responseText = await response.clone().text();
    assert.equal(response.status, 200, responseText);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      'https://itunes.apple.com/kr/rss/customerreviews/page=1/id=1018769995/sortby=mostrecent/json',
    );
    assert.equal(calls[0].headers.get('accept'), 'application/json');
    assert.equal(calls[0].headers.get('user-agent'), 'VoC-Radar/0.2');
    assert.match(calls[1].url, /\/WebObjects\/MZStore\.woa\/wa\/userReviewsRow\?/);
    assert.equal(calls[1].headers.get('x-apple-store-front'), '143466-13,29');

    const responsePayload = JSON.parse(responseText);
    assert.equal(responsePayload.data.totalFetched, 1);
    assert.equal(responsePayload.data.reviews[0].reviewId, 'review-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
