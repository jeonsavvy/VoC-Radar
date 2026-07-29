import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

let workerModule;
let tempDir;
const testDir = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(testDir, '../index.ts');
const workerModulePaths = ['index.ts', 'platform.ts', 'public.ts', 'private.ts', 'internal.ts']
  .map((file) => resolve(testDir, '..', file));
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_TOKEN = '66666666-6666-4666-8666-666666666666';
const RUN_ID = `RUN_${JOB_ID}_1`;

function createMemoryCacheStorage() {
  const entries = new Map();
  const cache = {
    async match(input) {
      const response = entries.get(typeof input === 'string' ? input : input.url);
      return response?.clone();
    },
    async put(input, response) {
      entries.set(typeof input === 'string' ? input : input.url, response.clone());
    },
  };

  return {
    async open() {
      return cache;
    },
  };
}

function replaceGlobalCaches(cacheStorage) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: cacheStorage,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'caches', descriptor);
    } else {
      delete globalThis.caches;
    }
  };
}

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

test('worker configuration retains workers.dev alongside the official custom domain and SPA fallback', () => {
  const config = readFileSync(resolve(testDir, '../../wrangler.toml'), 'utf8');

  assert.match(config, /^workers_dev = true$/m);
  assert.match(config, /pattern = "voc-radar\.satinode\.com", custom_domain = true/);
  assert.match(config, /not_found_handling = "single-page-application"/);
  assert.match(config, /run_worker_first = \["\/api\/\*"\]/);
});

test('worker entry delegates routes to focused modules without changing route fallthrough', () => {
  const [entry, platform, publicRoutes, privateRoutes, internalRoutes] = workerModulePaths
    .map((file) => readFileSync(file, 'utf8'));

  assert.ok(entry.split(/\r?\n/).length <= 250, 'entry stays limited to Worker orchestration');
  assert.match(entry, /routePublicRequest, routePrivateRequest, routeInternalRequest/);
  assert.match(entry, /if \(response\) return response;/);
  assert.match(platform, /export async function supabaseRequest/);
  assert.match(publicRoutes, /export async function routePublicRequest[\s\S]*?return null;/);
  assert.match(privateRoutes, /export async function routePrivateRequest[\s\S]*?return null;/);
  assert.match(internalRoutes, /export async function routeInternalRequest[\s\S]*?return null;/);
  assert.ok(internalRoutes.includes('return handler ? handler(await request.text()) : null;'));
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

test('public discovery batches app metadata and reuses the edge cache', async () => {
  const originalFetch = globalThis.fetch;
  const restoreCaches = replaceGlobalCaches(createMemoryCacheStorage());
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', headers: new Headers(init.headers) });

    if (url.includes('/rest/v1/pipeline_runs?')) {
      return Response.json([
        { app_store_id: '1018769995', country: 'kr', published_at: '2026-07-21T01:00:00.000Z' },
        { app_store_id: '1585915174', country: 'kr', published_at: '2026-07-21T00:00:00.000Z' },
      ]);
    }
    if (url.includes('/rest/v1/apps?')) {
      return Response.json([
        { app_store_id: '1018769995', country: 'kr', app_name: '당근' },
        { app_store_id: '1585915174', country: 'kr', app_name: '승리의 여신: 니케' },
      ]);
    }
    if (url.includes('itunes.apple.com/lookup?')) {
      return new Response(null, { status: 403 });
    }
    if (url.includes('apps.apple.com/kr/app/id1018769995')) {
      return new Response(
        '<meta property="og:title" content="당근 앱 - App Store"><meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/Purple/carrot/AppIcon/1200x630wa.jpg">',
        { status: 206, headers: { 'content-type': 'text/html' } },
      );
    }
    if (url.includes('apps.apple.com/kr/app/id1585915174')) {
      return new Response(
        '<meta property="og:title" content="승리의 여신: 니케 앱 - App Store"><meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/Purple/nikke/AppIcon/1200x630wa.jpg">',
        { status: 206, headers: { 'content-type': 'text/html' } },
      );
    }
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };

  try {
    const requestUrl = 'https://worker.example/api/public/discover?country=kr&limit=6';
    const env = {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_ANON_KEY: 'anon-key',
      PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
      API_RETRY_COUNT: '0',
    };

    const firstResponse = await workerModule.default.fetch(new Request(requestUrl), env);
    const firstPayload = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('cache-control'), 'public, max-age=120, s-maxage=120');
    assert.deepEqual(firstPayload.data.map((app) => app.appName), ['당근', '승리의 여신: 니케']);
    assert.deepEqual(firstPayload.data.map((app) => app.artworkUrl), [
      'https://is1-ssl.mzstatic.com/image/thumb/Purple/carrot/AppIcon/100x100bb.jpg',
      'https://is1-ssl.mzstatic.com/image/thumb/Purple/nikke/AppIcon/100x100bb.jpg',
    ]);
    assert.equal(calls.length, 5);
    const appsCall = calls.find((call) => call.url.includes('/rest/v1/apps?'));
    const catalogCall = calls.find((call) => call.url.includes('itunes.apple.com/lookup?'));
    const appStoreCalls = calls.filter((call) => call.url.includes('apps.apple.com/kr/app/id'));
    assert.match(appsCall.url, /app_store_id=in\.\(1018769995,1585915174\)/);
    assert.doesNotMatch(appsCall.url, /app_store_id=eq\./);
    assert.match(catalogCall.url, /id=1018769995,1585915174&country=KR/);
    assert.equal(appStoreCalls.length, 2);
    assert.ok(appStoreCalls.every((call) => call.headers.get('range') === 'bytes=0-16383'));

    const secondResponse = await workerModule.default.fetch(new Request(requestUrl), env);
    assert.equal(secondResponse.status, 200);
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCaches();
  }
});

test('public report includes App Store artwork and reuses the edge cache', async () => {
  const originalFetch = globalThis.fetch;
  const restoreCaches = replaceGlobalCaches(createMemoryCacheStorage());
  const calls = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/rest/v1/rpc/get_public_overview')) {
      return Response.json([{ total_reviews: 20, average_rating: 3.8, low_rating_count: 4 }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_public_categories')) return Response.json([]);
    if (url.endsWith('/rest/v1/rpc/get_public_trends')) return Response.json([]);
    if (url.endsWith('/rest/v1/rpc/get_public_issue_clusters_windowed')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_runs?')) {
      return Response.json([{ run_id: 'run-1', status: 'published', model_version: 'model-1', published_at: '2026-07-21T01:00:00.000Z' }]);
    }
    if (url.includes('/rest/v1/apps?')) return Response.json([{ app_name: '당근' }]);
    if (url.includes('itunes.apple.com/lookup?')) {
      return Response.json({
        results: [{ trackId: 1018769995, trackName: '당근', artworkUrl100: 'https://example.test/carrot.jpg' }],
      });
    }
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };

  try {
    const requestUrl = 'https://worker.example/api/public/report?appId=1018769995&country=kr';
    const env = {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_ANON_KEY: 'anon-key',
      PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
      API_RETRY_COUNT: '0',
      REPORT_V2_ENABLED: 'true',
    };

    const firstResponse = await workerModule.default.fetch(new Request(requestUrl), env);
    const firstPayload = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('cache-control'), 'public, max-age=120, s-maxage=120');
    assert.equal(firstPayload.data.app.appName, '당근');
    assert.equal(firstPayload.data.app.artworkUrl, 'https://example.test/carrot.jpg');
    assert.equal(firstPayload.data.summary.totalReviews, 20);
    assert.equal(calls.length, 7);

    const secondResponse = await workerModule.default.fetch(new Request(requestUrl), env);
    const secondPayload = await secondResponse.json();
    assert.deepEqual(secondPayload, firstPayload);
    assert.equal(calls.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCaches();
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

    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }

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
      jobId: JOB_ID,
      claimToken: CLAIM_TOKEN,
      runId: RUN_ID,
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
    assert.equal(calls.length, 3);
    assert.equal(
      calls[1].url,
      'https://itunes.apple.com/kr/rss/customerreviews/page=1/id=1018769995/sortby=mostrecent/json',
    );
    assert.equal(calls[1].headers.get('accept'), 'application/json');
    assert.equal(calls[1].headers.get('user-agent'), 'VoC-Radar/0.2');
    assert.match(calls[2].url, /\/WebObjects\/MZStore\.woa\/wa\/userReviewsRow\?/);
    assert.equal(calls[2].headers.get('x-apple-store-front'), '143466-13,29');

    const responsePayload = JSON.parse(responseText);
    assert.equal(responsePayload.data.totalFetched, 1);
    assert.equal(responsePayload.data.reviews[0].reviewId, 'review-1');
    assert.equal(responsePayload.data.complete, true);
    assert.equal(responsePayload.data.truncated, false);
    assert.equal(responsePayload.data.terminationReason, 'short_page');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('review fetch never returns partial success after a later Apple page failure', async () => {
  const scenarios = [
    () => new Response('', { status: 503 }),
    () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  for (const failedPage of scenarios) {
    const originalFetch = globalThis.fetch;
    let applePage = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
        return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
      }
      if (url.includes('/rss/customerreviews/')) {
        applePage += 1;
        if (applePage === 2) return failedPage();
        return Response.json({ feed: { entry: Array.from({ length: 50 }, (_, index) => ({
          id: { label: `review-${index}` },
          'im:rating': { label: '5' },
          updated: { label: new Date().toISOString() },
          author: { name: { label: 'reviewer' } },
          content: { label: `review ${index}` },
        })) } });
      }
      return Response.json({ code: 'unexpected' }, { status: 500 });
    };

    try {
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/fetch-reviews', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
          body: JSON.stringify({
            jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
            appStoreId: '1018769995', country: 'us', windowDays: 30, maxPages: 2,
          }),
        }),
        {
          SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
        },
      );
      const payload = await response.json();
      assert.equal(response.status, 502);
      assert.equal(payload.error, 'upstream_unavailable');
      assert.equal(payload.retryable, true);
      assert.equal(Object.hasOwn(payload, 'data'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('review fetch proves a full 40-page boundary with one terminal probe under 50 subrequests', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, redirect: init.redirect });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.includes('/rss/customerreviews/')) {
      const page = Number(url.match(/page=(\d+)/)?.[1] || 0);
      if (page === 41) return Response.json({ feed: { entry: [] } });
      return Response.json({ feed: { entry: Array.from({ length: 50 }, (_, index) => ({
        id: { label: `review-${page}-${index}` },
        'im:rating': { label: '4' },
        updated: { label: new Date().toISOString() },
        author: { name: { label: 'reviewer' } },
        content: { label: `review ${page}-${index}` },
      })) } });
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/fetch-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '1018769995', country: 'us', windowDays: 30, maxPages: 40,
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.data.totalFetched, 2_000);
    assert.equal(payload.data.pagesFetched, 40);
    assert.equal(payload.data.complete, true);
    assert.equal(payload.data.truncated, false);
    assert.equal(payload.data.terminationReason, 'empty_page');
    assert.equal(calls.length, 45);
    const appleCalls = calls.filter((call) => call.url.includes('itunes.apple.com'));
    assert.equal(appleCalls.length, 41);
    assert.ok(appleCalls.every((call) => call.redirect === 'manual'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('review fetch terminalizes a capacity-bound collection without exposing partial reviews', async () => {
  const originalFetch = globalThis.fetch;
  let completionBody;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      completionBody = JSON.parse(String(init.body));
      return Response.json([{ job_id: JOB_ID, status: 'failed' }]);
    }
    if (url.includes('/rss/customerreviews/')) {
      return Response.json({ feed: { entry: [
        {
          id: { label: 'review-1' }, 'im:rating': { label: '5' },
          updated: { label: new Date().toISOString() }, content: { label: 'first' },
        },
        {
          id: { label: 'review-2' }, 'im:rating': { label: '4' },
          updated: { label: new Date().toISOString() }, content: { label: 'second' },
        },
      ] } });
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/fetch-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '1018769995', country: 'us', windowDays: 30, maxPages: 1, limit: 1,
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.error, 'review_scope_incomplete');
    assert.equal(Object.hasOwn(payload, 'data'), false);
    assert.equal(completionBody.p_status, 'failed');
    assert.equal(completionBody.p_error_message, 'review_scope_incomplete');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private account deletion cancels running jobs before deleting the auth user', async () => {
  const originalFetch = globalThis.fetch;
  const userId = '11111111-1111-4111-8111-111111111111';
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body ? String(init.body) : '',
    });

    if (url.endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: userId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/rest/v1/rpc/prepare_account_deletion')) {
      return new Response(JSON.stringify([{ canceled_jobs: 1, redacted_jobs: 3 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith(`/auth/v1/admin/users/${userId}`)) {
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'unexpected url' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/account', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer user-token',
        },
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key',
        PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
        API_TIMEOUT_MS: '50',
        API_RETRY_COUNT: '0',
      },
    );

    const responsePayload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(responsePayload, {
      ok: true,
      data: {
        deleted: true,
        canceledJobs: 1,
        redactedJobs: 3,
      },
    });
    assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/user');
    assert.equal(calls[1].method, 'POST');
    assert.match(calls[1].url, /\/rest\/v1\/rpc\/prepare_account_deletion$/);
    assert.equal(JSON.parse(calls[1].body).p_requested_by, userId);
    assert.deepEqual(Object.keys(JSON.parse(calls[1].body)), ['p_requested_by']);
    assert.equal(calls[2].method, 'DELETE');
    assert.equal(calls[2].url, `https://example.supabase.co/auth/v1/admin/users/${userId}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('analysis request returns fresh during the 24 hour cooldown', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    if (url.includes('/rest/v1/pipeline_runs?')) {
      return Response.json([{ run_id: 'run-fresh', published_at: new Date().toISOString() }]);
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.result, 'fresh');
    assert.equal(payload.data.runId, 'run-fresh');
    assert.ok(payload.data.nextAllowedAt);
  } finally { globalThis.fetch = originalFetch; }
});

test('analysis request returns the existing active app job', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && url.includes('status=eq.completed')) {
      return Response.json([]);
    }
    if (url.includes('/rest/v1/pipeline_jobs?')) {
      return Response.json([{
        id: 'job-existing',
        app_store_id: '123456789',
        country: 'kr',
        status: 'running',
        stage: 'extracting',
        requested_at: '2026-07-29T00:00:00.000Z',
      }]);
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', {
        method: 'POST', headers: { Authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.result, 'existing');
    assert.equal(payload.data.id, 'job-existing');
  } finally { globalThis.fetch = originalFetch; }
});

test('analysis request uses a completed no-new-review check as the cooldown boundary', async () => {
  const originalFetch = globalThis.fetch;
  const finishedAt = new Date().toISOString();
  const publishedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    if (url.includes('/rest/v1/pipeline_runs?') && url.includes('published_at=gte.')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && url.includes('status=eq.completed')) {
      return Response.json([{ id: 'job-completed', run_id: null, finished_at: finishedAt }]);
    }
    if (url.includes('/rest/v1/pipeline_runs?')) {
      return Response.json([{ run_id: 'run-latest', published_at: publishedAt }]);
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', {
        method: 'POST', headers: { Authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.result, 'fresh');
    assert.equal(payload.data.runId, 'run-latest');
    assert.equal(payload.data.publishedAt, publishedAt);
    assert.equal(
      payload.data.nextAllowedAt,
      new Date(new Date(finishedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
    );
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/pipeline_jobs') && call.method === 'POST'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('analysis request queues one new job with the queued stage', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method || 'GET',
      body: init.body ? String(init.body) : '',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && (init.method || 'GET') === 'GET') return Response.json([]);
    if (url.includes('itunes.apple.com/lookup?')) return Response.json({
      results: [{ trackId: 123456789, trackName: '검증된 앱', wrapperType: 'software' }],
    });
    if (url.endsWith('/rest/v1/rpc/enqueue_pipeline_job')) {
      const body = JSON.parse(String(init.body));
      return Response.json({
        result: 'queued',
        data: {
          id: 'job-new',
          app_store_id: body.p_app_store_id,
          country: body.p_country,
          app_name: body.p_app_name,
          status: 'queued',
          stage: 'queued',
          run_id: null,
          requested_at: '2026-07-29T00:00:00.000Z',
          updated_at: '2026-07-29T00:00:00.000Z',
        },
      });
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', {
        method: 'POST', headers: { Authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr', appName: '테스트 앱' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        APPLE_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.result, 'queued');
    assert.equal(payload.data.stage, 'queued');
    const enqueue = calls.find((call) => call.url.endsWith('/rest/v1/rpc/enqueue_pipeline_job'));
    assert.equal(JSON.parse(enqueue.body).p_app_store_id, '123456789');
    assert.equal(JSON.parse(enqueue.body).p_app_name, '검증된 앱');
    assert.equal(JSON.parse(enqueue.body).p_requested_by, '11111111-1111-4111-8111-111111111111');
    assert.equal(enqueue.headers.apikey, 'service-role-key');
    assert.equal(enqueue.headers.authorization, 'Bearer service-role-key');
  } finally { globalThis.fetch = originalFetch; }
});

test('analysis request reports a retryable queue outage when the service insert is forbidden', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && (init.method || 'GET') === 'GET') return Response.json([]);
    if (url.includes('itunes.apple.com/lookup?')) return Response.json({
      results: [{ trackId: 123456789, trackName: '검증된 앱', wrapperType: 'software' }],
    });
    if (url.endsWith('/rest/v1/rpc/enqueue_pipeline_job')) {
      return Response.json({ code: '42501', message: 'permission denied' }, { status: 403 });
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key',
        PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
        APPLE_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
        API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error, 'job_queue_unavailable');
    assert.equal(payload.retryable, true);
    assert.match(payload.message, /요청은 시작되지 않았습니다/);
  } finally { globalThis.fetch = originalFetch; }
});

test('forced reanalysis keeps existing reviews in the extraction stage', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? String(init.body) : '' });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json([{ get_pipeline_review_scope: [{
        review_id: 'review-existing',
        app_store_id: '123456789',
        country: 'kr',
        priority: 'high',
        category: 'stability',
        summary: '앱이 종료됨',
      }] }]);
    }
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID,
          claimToken: CLAIM_TOKEN,
          runId: RUN_ID,
          appStoreId: '123456789',
          country: 'kr',
          forceReanalysis: true,
          reviews: [{
            reviewId: 'review-existing',
            author: 'latest-reviewer',
            content: '새로 수정된 리뷰',
            rating: 1,
            reviewedAt: '2026-07-21T00:00:00.000Z',
          }],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.forceReanalysis, true);
    assert.equal(payload.data.autoCompleted, false);
    assert.equal(payload.data.newCount, 0);
    assert.equal(payload.data.existingExtractions.length, 1);
    assert.equal(payload.data.existingExtractions[0].ID, 'review-existing');
    assert.equal(payload.data.existingExtractions[0].author, 'latest-reviewer');
    assert.equal(payload.data.existingExtractions[0].content, '새로 수정된 리뷰');
    assert.equal(payload.data.existingExtractions[0].rating, 1);
    assert.equal(payload.data.existingExtractions[0].date, '2026-07-21T00:00:00.000Z');
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')), false);
    const stageUpdates = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim'));
    assert.ok(stageUpdates.length >= 2);
    assert.equal(JSON.parse(stageUpdates.at(-1).body).p_stage, 'extracting');
  } finally { globalThis.fetch = originalFetch; }
});

test('scalar scope omissions remain fresh reviews without an extra lookup', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = String(init.body || '');
    calls.push({ url, body });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'extracting' }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json({
        get_pipeline_review_scope: [{
          review_id: 'review-existing', app_store_id: '123456789', country: 'kr',
          priority: 'medium', category: '기능 및 사용성', summary: 'stored-summary',
        }],
      });
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr',
          reviews: [
            { reviewId: 'review-existing', rating: 2 },
            { reviewId: 'review-fresh', rating: 5 },
          ],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.existingCount, 1);
    assert.equal(payload.data.newCount, 1);
    assert.deepEqual(payload.data.reviews.map((row) => row.reviewId), ['review-fresh']);
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')).length, 3);
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('forced reanalysis resolves 10k existing reviews through one scalar scope RPC', async () => {
  const originalFetch = globalThis.fetch;
  const reviewIds = Array.from({ length: 10_000 }, (_, index) => `review-${String(index).padStart(5, '0')}`);
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = String(init.body || '');
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'extracting' }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      const requestBody = JSON.parse(body);
      return Response.json(requestBody.p_review_ids.toReversed().map((review_id) => ({
        review_id,
        app_store_id: '123456789',
        country: 'kr',
        priority: 'medium',
        category: '기능 및 사용성',
        summary: 'stored-summary',
      })));
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', forceReanalysis: true,
          reviews: reviewIds.map((reviewId) => ({
            reviewId, author: `incoming-${reviewId}`, content: `content-${reviewId}`,
            rating: 1, reviewedAt: '2026-07-21T00:00:00.000Z',
          })),
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.existingExtractions.length, reviewIds.length);
    assert.deepEqual(payload.data.existingExtractions.map((row) => row.ID), reviewIds);

    const lookups = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/get_pipeline_review_scope'));
    assert.equal(lookups.length, 1);
    const lookupBody = JSON.parse(lookups[0].body);
    assert.deepEqual(lookupBody, {
      p_app_store_id: '123456789',
      p_country: 'kr',
      p_review_ids: reviewIds,
      p_include_analysis: true,
    });
    assert.equal(lookups[0].headers.apikey, 'service-role-key');
    assert.equal(lookups[0].headers.authorization, 'Bearer service-role-key');

    const heartbeats = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim'));
    assert.equal(heartbeats.length, 3);
    assert.ok(heartbeats.every((call) => JSON.parse(call.body).p_stage === 'extracting'));
    const paths = calls.map((call) => new URL(call.url).pathname);
    assert.deepEqual(paths, [
      '/rest/v1/rpc/renew_pipeline_job_claim',
      '/rest/v1/rpc/renew_pipeline_job_claim',
      '/rest/v1/rpc/get_pipeline_review_scope',
      '/rest/v1/rpc/renew_pipeline_job_claim',
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test('forced reanalysis discards a 10k scalar lookup when its post-RPC claim fence fails', async () => {
  const originalFetch = globalThis.fetch;
  const reviewIds = Array.from({ length: 10_000 }, (_, index) => `review-${String(index).padStart(5, '0')}`);
  const calls = [];
  let renewals = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = String(init.body || '');
    calls.push({ url, body });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      renewals += 1;
      return Response.json(renewals < 3
        ? [{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'extracting' }]
        : []);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json(JSON.parse(body).p_review_ids.map((review_id) => ({
        review_id, app_store_id: '123456789', country: 'kr',
      })));
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', forceReanalysis: true,
          reviews: reviewIds.map((reviewId) => ({ reviewId, rating: 1 })),
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'job_claim_lost');
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')).length, 3);
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('forced reanalysis rejects duplicate, unrequested, or cross-scope scalar rows', async () => {
  const originalFetch = globalThis.fetch;
  const scenarios = [
    [
      { review_id: 'review-1', app_store_id: '123456789', country: 'kr' },
      { review_id: 'review-1', app_store_id: '123456789', country: 'kr' },
    ],
    [{ review_id: 'review-other', app_store_id: '123456789', country: 'kr' }],
    [{ review_id: 'review-1', app_store_id: '999999999', country: 'kr' }],
  ];

  try {
    for (const rows of scenarios) {
      const calls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, body: String(init.body || '') });
        if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
          return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'extracting' }]);
        }
        if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) return Response.json(rows);
        if (url.endsWith('/rest/v1/rpc/complete_pipeline_job')) {
          return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
        }
        return Response.json({ code: 'unexpected' }, { status: 500 });
      };

      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
          body: JSON.stringify({
            jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
            appStoreId: '123456789', country: 'kr', forceReanalysis: true,
            reviews: [{ reviewId: 'review-1', rating: 1 }],
          }),
        }),
        {
          SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        },
      );
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error, 'unknown_review_ids');
      assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')).length, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('no-new-review fast path can still complete a claim without creating a run', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: String(init.body || '') });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'completed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', reviews: [],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.autoCompleted, true);
    const completion = calls.find((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job'));
    assert.equal(JSON.parse(completion.body).p_status, 'completed');
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/pipeline_runs')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster context unwraps the complete bounded identity-set scalar response', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', body: init.body ? String(init.body) : '' });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_cluster_context_v2')) {
      return Response.json({ get_pipeline_cluster_context_v2: [{
        issue_id: '44444444-4444-4444-8444-444444444444',
        canonical_key: 'stability-crash',
        title: '앱 강제 종료',
        category: '버그 및 성능',
        summary: '실행 중 앱이 반복 종료됨',
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-20T00:00:00.000Z',
        review_count: 12,
      }] });
    }
    return Response.json({ error: `unexpected ${init.method || 'GET'} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/cluster-context', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr',
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].canonicalKey, 'stability-crash');
    assert.equal(payload.data[0].reviewCount, 12);
    assert.match(calls[0].url, /renew_pipeline_job_claim$/);
    assert.match(calls[1].url, /get_pipeline_cluster_context_v2$/);
    assert.equal(JSON.parse(calls[1].body).p_app_store_id, '123456789');
    assert.match(calls[2].url, /renew_pipeline_job_claim$/);
  } finally { globalThis.fetch = originalFetch; }
});

test('reanalysis cluster upsert suppresses non-comparable change metrics', async () => {
  const originalFetch = globalThis.fetch;
  const clusterId = '55555555-5555-4555-8555-555555555555';
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? String(init.body) : '' });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json([{
        review_id: 'review-1', app_store_id: '123456789', country: 'kr',
        reviewed_at: '2026-07-20T00:00:00.000Z',
      }]);
    }
    if (url.endsWith('/rest/v1/rpc/persist_issue_clusters')) {
      return Response.json([{ run_id: RUN_ID, cluster_count: 1, assigned_review_count: 1 }]);
    }
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID,
          claimToken: CLAIM_TOKEN,
          runId: RUN_ID,
          appStoreId: '123456789',
          country: 'kr',
          modelVersion: 'fixture-model',
          comparisonEligible: false,
          inputReviewIds: ['review-1'],
          result: {
            extractions: [{ reviewId: 'review-1', category: '버그 및 성능', summary: '앱이 종료됨' }],
            clusters: [{
              existingClusterId: clusterId,
              canonicalKey: 'stability-crash',
              title: '앱 강제 종료',
              category: '버그 및 성능',
              severity: 'high',
              summary: '핵심 이용 중 앱이 종료됨',
              actionHint: '충돌 로그 확인',
              reviewIds: ['review-1'],
              representativeReviewIds: ['review-1'],
            }],
          },
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(calls.some((call) => call.url.includes('issue_cluster_snapshots?select=review_count')), false);
    const reviewScope = JSON.parse(calls.find((call) =>
      call.url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')).body);
    assert.deepEqual(reviewScope, {
      p_app_store_id: '123456789', p_country: 'kr',
      p_review_ids: ['review-1'], p_include_analysis: false,
    });
    const persistence = calls.find((call) => call.url.endsWith('/rest/v1/rpc/persist_issue_clusters'));
    const rpcBody = JSON.parse(persistence.body);
    assert.equal(rpcBody.p_comparison_eligible, false);
    assert.equal(rpcBody.p_validation_result.comparisonEligible, false);
    assert.equal(rpcBody.p_clusters[0].existing_cluster_id, clusterId);
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster persistence bounds summaries to the context read contract', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? String(init.body) : '' });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json([{
        review_id: 'review-1', app_store_id: '123456789', country: 'kr',
        reviewed_at: '2026-07-20T00:00:00.000Z',
      }]);
    }
    if (url.endsWith('/rest/v1/rpc/persist_issue_clusters')) {
      return Response.json([{ run_id: RUN_ID, cluster_count: 1, assigned_review_count: 1 }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', modelVersion: 'fixture-model',
          inputReviewIds: ['review-1'],
          result: {
            extractions: [{ reviewId: 'review-1', category: '버그 및 성능', summary: '앱이 종료됨' }],
            clusters: [{
              canonicalKey: 'bounded-summary', title: '요약 경계', category: '버그 및 성능',
              severity: 'high', summary: 'x'.repeat(401), reviewIds: ['review-1'],
              representativeReviewIds: ['review-1'],
            }],
          },
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const persistence = calls.find((call) => call.url.endsWith('/rest/v1/rpc/persist_issue_clusters'));
    const persistedSummary = JSON.parse(persistence.body).p_clusters[0].summary;
    assert.equal(persistedSummary.length, 400);
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster upsert retry remains idempotent after persistence advanced the job to publishing', async () => {
  const originalFetch = globalThis.fetch;
  const clusterId = '66666666-6666-4666-8666-666666666666';
  const calls = [];
  let stage = 'clustering';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      const order = ['queued', 'fetching', 'extracting', 'clustering', 'publishing'];
      if (body.p_stage && order.indexOf(body.p_stage) < order.indexOf(stage)) return Response.json([]);
      if (body.p_stage) stage = body.p_stage;
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json([{
        review_id: 'review-1', app_store_id: '123456789', country: 'kr',
        reviewed_at: '2026-07-20T00:00:00.000Z',
      }]);
    }
    if (url.endsWith('/rest/v1/rpc/persist_issue_clusters')) {
      stage = 'publishing';
      return Response.json([{ run_id: RUN_ID, cluster_count: 1, assigned_review_count: 1 }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  const requestBody = JSON.stringify({
    jobId: JOB_ID,
    claimToken: CLAIM_TOKEN,
    runId: RUN_ID,
    appStoreId: '123456789',
    country: 'kr',
    modelVersion: 'fixture-model',
    inputReviewIds: ['review-1'],
    result: {
      extractions: [{ reviewId: 'review-1', category: '버그 및 성능', summary: '앱이 종료됨' }],
      clusters: [{
        existingClusterId: clusterId,
        canonicalKey: 'stability-crash',
        title: '앱 강제 종료',
        category: '버그 및 성능',
        severity: 'high',
        summary: '핵심 이용 중 앱이 종료됨',
        actionHint: '충돌 로그 확인',
        reviewIds: ['review-1'],
        representativeReviewIds: ['review-1'],
      }],
    },
  });
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
  };

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
          body: requestBody,
        }),
        env,
      );
      assert.equal(response.status, 200, await response.clone().text());
    }

    const guards = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim'));
    assert.equal(guards.length, 6);
    assert.deepEqual(guards.map((call) => call.body.p_stage), Array(6).fill(null));
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/persist_issue_clusters')).length, 2);
    assert.equal(stage, 'publishing');
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster upsert resolves the full 10k review scope through one scalar RPC', async () => {
  const originalFetch = globalThis.fetch;
  const reviewIds = Array.from({ length: 10_000 }, (_, index) => `review-${String(index).padStart(5, '0')}`);
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = String(init.body || '');
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'clustering' }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json([{ get_pipeline_review_scope: JSON.parse(body).p_review_ids.toReversed().map((review_id) => ({
        review_id, app_store_id: '123456789', country: 'kr',
        reviewed_at: '2026-07-20T00:00:00.000Z',
      })) }]);
    }
    if (url.endsWith('/rest/v1/rpc/persist_issue_clusters')) {
      return Response.json([{ run_id: RUN_ID, cluster_count: 1, assigned_review_count: reviewIds.length }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  const result = {
    extractions: reviewIds.map((reviewId) => ({
      reviewId, category: '버그 및 성능', summary: `summary-${reviewId}`,
    })),
    clusters: [{
      canonicalKey: 'stability-crash', title: '앱 강제 종료', category: '버그 및 성능', severity: 'high',
      summary: '핵심 이용 중 앱이 종료됨', actionHint: '충돌 로그 확인', reviewIds,
      representativeReviewIds: reviewIds.slice(0, 3),
    }],
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', modelVersion: 'fixture-model',
          inputReviewIds: reviewIds, result,
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 200, await response.clone().text());

    const lookups = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/get_pipeline_review_scope'));
    assert.equal(lookups.length, 1);
    assert.deepEqual(JSON.parse(lookups[0].body), {
      p_app_store_id: '123456789',
      p_country: 'kr',
      p_review_ids: reviewIds,
      p_include_analysis: false,
    });
    assert.equal(lookups[0].headers.apikey, 'service-role-key');
    assert.equal(lookups[0].headers.authorization, 'Bearer service-role-key');

    const heartbeats = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim'));
    assert.equal(heartbeats.length, 3);
    assert.ok(heartbeats.every((call) => JSON.parse(call.body).p_stage === null));
    const persistence = calls.filter((call) => call.url.endsWith('/rest/v1/rpc/persist_issue_clusters'));
    assert.equal(persistence.length, 1);
    assert.equal(JSON.parse(persistence[0].body).p_clusters[0].review_ids.length, reviewIds.length);
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster upsert discards a 10k scalar lookup when its post-RPC claim fence fails', async () => {
  const originalFetch = globalThis.fetch;
  const reviewIds = Array.from({ length: 10_000 }, (_, index) => `review-${String(index).padStart(5, '0')}`);
  const calls = [];
  let renewals = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = String(init.body || '');
    calls.push({ url, body });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      renewals += 1;
      return Response.json(renewals < 3
        ? [{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'clustering' }]
        : []);
    }
    if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) {
      return Response.json(JSON.parse(body).p_review_ids.map((review_id) => ({
        review_id, app_store_id: '123456789', country: 'kr',
        reviewed_at: '2026-07-20T00:00:00.000Z',
      })));
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  const result = {
    extractions: reviewIds.map((reviewId) => ({
      reviewId, category: '버그 및 성능', summary: `summary-${reviewId}`,
    })),
    clusters: [{
      canonicalKey: 'stability-crash', title: '앱 강제 종료', category: '버그 및 성능', severity: 'high',
      summary: '핵심 이용 중 앱이 종료됨', reviewIds, representativeReviewIds: reviewIds.slice(0, 3),
    }],
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', modelVersion: 'fixture-model',
          inputReviewIds: reviewIds, result,
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'job_claim_lost');
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')).length, 3);
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/persist_issue_clusters')), false);
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster upsert preserves unknown_review_ids for missing or invalid scoped rows', async () => {
  const originalFetch = globalThis.fetch;
  const scenarios = [
    [{ review_id: 'review-1', app_store_id: '123456789', country: 'kr', reviewed_at: '2026-07-20T00:00:00.000Z' }],
    [
      { review_id: 'review-1', app_store_id: '123456789', country: 'kr', reviewed_at: '2026-07-20T00:00:00.000Z' },
      { review_id: 'review-other', app_store_id: '123456789', country: 'kr', reviewed_at: '2026-07-20T00:00:00.000Z' },
    ],
    [
      { review_id: 'review-1', app_store_id: '999999999', country: 'kr', reviewed_at: '2026-07-20T00:00:00.000Z' },
      { review_id: 'review-2', app_store_id: '123456789', country: 'kr', reviewed_at: '2026-07-20T00:00:00.000Z' },
    ],
  ];
  const inputReviewIds = ['review-1', 'review-2'];
  const result = {
    extractions: inputReviewIds.map((reviewId) => ({ reviewId, category: '버그 및 성능', summary: 'summary' })),
    clusters: [{
      canonicalKey: 'stability-crash', title: '앱 강제 종료', category: '버그 및 성능', severity: 'high',
      summary: '핵심 이용 중 앱이 종료됨', reviewIds: inputReviewIds,
      representativeReviewIds: inputReviewIds,
    }],
  };

  try {
    for (const rows of scenarios) {
      const calls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, body: String(init.body || '') });
        if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
          return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID, stage: 'clustering' }]);
        }
        if (url.endsWith('/rest/v1/rpc/get_pipeline_review_scope')) return Response.json(rows);
        if (url.endsWith('/rest/v1/rpc/complete_pipeline_job')) {
          return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
        }
        return Response.json({ code: 'unexpected' }, { status: 500 });
      };
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
          body: JSON.stringify({
            jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
            appStoreId: '123456789', country: 'kr', modelVersion: 'fixture-model',
            inputReviewIds, result,
          }),
        }),
        {
          SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        },
      );
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error, 'unknown_review_ids');
      assert.equal(calls.filter((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')).length, 1);
      assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/persist_issue_clusters')), false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('validated publish delegates run, pointer, and job completion to one atomic RPC', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? String(init.body) : '' });
    if (url.endsWith('/rest/v1/rpc/publish_pipeline_run')) {
      return Response.json([{ run_id: RUN_ID, published_at: '2026-07-26T00:00:00.000Z', cluster_count: 1 }]);
    }
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr',
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        REPORT_V2_ENABLED: 'true',
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/publish_pipeline_run$/);
    const rpcBody = JSON.parse(calls[0].body);
    assert.equal(rpcBody.p_job_id, JOB_ID);
    assert.equal(rpcBody.p_claim_token, CLAIM_TOKEN);
    assert.equal(rpcBody.p_run_id, RUN_ID);
  } finally { globalThis.fetch = originalFetch; }
});

test('claim-job forwards one claimKey and returns the fenced lease contract', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    return Response.json([{
      job_id: JOB_ID,
      app_store_id: '123456789',
      country: 'kr',
      source: 'web',
      status: 'running',
      requested_at: '2026-07-26T00:00:00.000Z',
      claim_token: CLAIM_TOKEN,
      lease_expires_at: '2026-07-26T00:15:00.000Z',
      attempt_count: 1,
    }]);
  };

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/claim-job', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-voc-token': 'pipeline-secret',
            'x-idempotency-key': 'execution-42',
          },
          body: JSON.stringify({ claimKey: 'execution-42' }),
        }),
        {
          SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        },
      );
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(
        {
          status: payload.data.status,
          jobId: payload.data.jobId,
          claimToken: payload.data.claimToken,
          leaseExpiresAt: payload.data.leaseExpiresAt,
          attemptCount: payload.data.attemptCount,
        },
        {
          status: 'running', jobId: JOB_ID, claimToken: CLAIM_TOKEN,
          leaseExpiresAt: '2026-07-26T00:15:00.000Z', attemptCount: 1,
        },
      );
    }
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[0].body).p_claim_key, 'execution-42');
    assert.equal(JSON.parse(calls[1].body).p_claim_key, 'execution-42');
  } finally { globalThis.fetch = originalFetch; }
});

test('pipeline heartbeat renews only an authenticated active claim and rejects stale claimants', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
  };
  const requestFor = (body, token = 'pipeline-secret') => new Request(
    'https://worker.example/api/internal/pipeline/heartbeat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voc-token': token },
      body: JSON.stringify(body),
    },
  );

  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body || '{}')) });
    return Response.json([{
      status: 'running',
      stage: 'extracting',
      lease_expires_at: '2026-07-26T00:15:00.000Z',
    }]);
  };

  try {
    const body = { jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, stage: 'extracting' };
    const response = await workerModule.default.fetch(requestFor(body), env);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, {
      status: 'running',
      stage: 'extracting',
      leaseExpiresAt: '2026-07-26T00:15:00.000Z',
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/renew_pipeline_job_claim$/);
    assert.deepEqual(calls[0].body, {
      p_job_id: JOB_ID,
      p_claim_token: CLAIM_TOKEN,
      p_run_id: RUN_ID,
      p_stage: 'extracting',
    });

    const invalidStage = await workerModule.default.fetch(
      requestFor({ ...body, stage: 'publishing' }),
      env,
    );
    assert.equal(invalidStage.status, 400);
    assert.equal(calls.length, 1);

    const unauthorizedResponse = await workerModule.default.fetch(
      requestFor(body, 'wrong-secret'),
      env,
    );
    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(calls.length, 1);

    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), body: JSON.parse(String(init.body || '{}')) });
      return Response.json([]);
    };
    const staleResponse = await workerModule.default.fetch(
      requestFor({ ...body, stage: 'clustering' }),
      env,
    );
    const stalePayload = await staleResponse.json();
    assert.equal(staleResponse.status, 409);
    assert.equal(stalePayload.error, 'job_claim_lost');
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('direct completion of an unpublished or cross-app published run returns a safe conflict', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    return Response.json({
      code: '23514',
      message: 'published pipeline run belongs to another app scope: private-run-detail',
    }, { status: 400 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/job-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, status: 'completed',
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'pipeline_completion_rejected');
    assert.equal(payload.retryable, false);
    assert.doesNotMatch(text, /private-run-detail|must be published/i);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].body).p_status, 'completed');
  } finally { globalThis.fetch = originalFetch; }
});

test('a canceled or stale review upsert returns job_claim_lost without fallback writes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || 'GET' });
    if (String(input).endsWith('/rest/v1/rpc/persist_pipeline_reviews')) return Response.json([]);
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, source: 'n8n',
          app: { appStoreId: '123456789', country: 'kr' },
          reviews: [{ reviewId: 'rejected-review', rating: 1, content: 'valid' }],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'job_claim_lost');
    assert.equal(payload.ok, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /persist_pipeline_reviews$/);
    assert.equal(calls.some((call) => call.method === 'PATCH'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('a cross-app review conflict rejects the whole persistence request safely', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || 'GET', body: String(init.body || '') });
    if (String(input).endsWith('/rest/v1/rpc/persist_pipeline_reviews')) {
      return Response.json({
        code: '23514',
        message: 'review already belongs to another app scope: private-app-id',
      }, { status: 400 });
    }
    if (String(input).endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID,
          claimToken: CLAIM_TOKEN,
          runId: RUN_ID,
          source: 'n8n',
          app: { appStoreId: '123456789', country: 'kr' },
          reviews: [{ reviewId: 'shared-review', rating: 1, content: 'crash' }],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'pipeline_review_rejected');
    assert.doesNotMatch(text, /private-app-id|another app scope|service-role-key/i);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[1].url, /complete_pipeline_job$/);
    assert.equal(JSON.parse(calls[1].body).p_status, 'failed');
  } finally { globalThis.fetch = originalFetch; }
});

test('duplicate review ids are rejected deterministically and terminalize the claim', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    if (String(input).endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, source: 'n8n',
          app: { appStoreId: '123456789', country: 'kr' },
          reviews: [
            { reviewId: 'duplicate-review', rating: 1, content: 'first' },
            { reviewId: 'duplicate-review', rating: 2, content: 'second' },
          ],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'pipeline_review_rejected');
    assert.equal(payload.retryable, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /complete_pipeline_job$/);
    assert.equal(JSON.parse(calls[0].body).p_status, 'failed');
  } finally { globalThis.fetch = originalFetch; }
});

test('review persistence rejects empty and over-cap batches before database persistence', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    if (String(input).endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  const batches = [
    [],
    Array.from({ length: 10_001 }, (_, index) => ({
      reviewId: `review-${index}`,
      rating: 3,
      content: 'bounded',
    })),
  ];

  try {
    for (const reviews of batches) {
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
          body: JSON.stringify({
            jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, source: 'n8n',
            app: { appStoreId: '123456789', country: 'kr' }, reviews,
          }),
        }),
        {
          SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        },
      );
      const payload = await response.json();
      assert.equal(response.status, 409);
      assert.equal(payload.error, 'pipeline_review_rejected');
    }
    assert.equal(calls.length, batches.length);
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/persist_pipeline_reviews')), false);
    assert.ok(calls.every((call) => JSON.parse(call.body).p_status === 'failed'));
  } finally { globalThis.fetch = originalFetch; }
});

test('invalid review scalars are rejected before persistence and terminalize safely', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    if (String(input).endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  const invalidReviews = [
    { reviewId: 'bad-rating', rating: 1.5, content: 'bad' },
    { reviewId: 'bad-date', rating: 1, reviewedAt: 'not-a-timestamp', content: 'bad' },
    { reviewId: 'bad-confidence', rating: 1, confidence: 1.01, content: 'bad' },
  ];

  try {
    for (const review of invalidReviews) {
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
          body: JSON.stringify({
            jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, source: 'n8n',
            app: { appStoreId: '123456789', country: 'kr' }, reviews: [review],
          }),
        }),
        {
          SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        },
      );
      const payload = await response.json();
      assert.equal(response.status, 409);
      assert.equal(payload.error, 'pipeline_review_rejected');
      assert.equal(payload.retryable, false);
    }
    assert.equal(calls.length, invalidReviews.length);
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/persist_pipeline_reviews')), false);
    assert.ok(calls.every((call) => JSON.parse(call.body).p_status === 'failed'));
  } finally { globalThis.fetch = originalFetch; }
});

test('SQLSTATE 22 data exceptions terminalize review persistence as nonretryable', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    if (String(input).endsWith('/rest/v1/rpc/persist_pipeline_reviews')) {
      return Response.json({ code: '22003', message: 'private numeric overflow detail' }, { status: 400 });
    }
    if (String(input).endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, source: 'n8n',
          app: { appStoreId: '123456789', country: 'kr' },
          reviews: [{ reviewId: 'valid-review', rating: 1, confidence: 0.5, content: 'valid' }],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'pipeline_review_rejected');
    assert.equal(payload.retryable, false);
    assert.doesNotMatch(text, /numeric overflow|private/i);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].body).p_status, 'failed');
  } finally { globalThis.fetch = originalFetch; }
});

test('a rejected review persistence returns job_claim_lost when terminalization loses the claim', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: String(init.body || '') });
    if (String(input).endsWith('/rest/v1/rpc/persist_pipeline_reviews')) {
      return Response.json({ code: '23514', message: 'private constraint detail' }, { status: 400 });
    }
    if (String(input).endsWith('/rest/v1/rpc/complete_pipeline_job')) return Response.json([]);
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID, source: 'n8n',
          app: { appStoreId: '123456789', country: 'kr' },
          reviews: [{ reviewId: 'rejected-review', rating: 1, content: 'valid' }],
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(text).error, 'job_claim_lost');
    assert.doesNotMatch(text, /private constraint detail/i);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('a canceled cluster attempt stops at the claim guard', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    if (String(input).endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'canceled', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', modelVersion: 'fixture',
          inputReviewIds: [], result: {},
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'job_claim_lost');
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/rest/v1/rpc/renew_pipeline_job_claim']);
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster persistence rejects an over-cap review contract before scope lookup', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: String(init.body || '') });
    if (url.endsWith('/rest/v1/rpc/renew_pipeline_job_claim')) {
      return Response.json([{ job_id: JOB_ID, status: 'running', run_id: RUN_ID }]);
    }
    if (url.endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  const inputReviewIds = Array.from({ length: 10_001 }, (_, index) => `review-${index}`);

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr', modelVersion: 'fixture',
          inputReviewIds, result: {},
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'cluster_contract_invalid');
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      '/rest/v1/rpc/renew_pipeline_job_claim',
      '/rest/v1/rpc/complete_pipeline_job',
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test('publish validation rejection terminalizes the current claim without leaking the upstream body', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, body: String(init.body || '') });
    if (url.endsWith('/rest/v1/rpc/publish_pipeline_run')) {
      return Response.json({ code: '23514', message: 'SUPABASE_SERVICE_ROLE_KEY=do-not-leak' }, { status: 400 });
    }
    if (url.endsWith('/rest/v1/rpc/complete_pipeline_job')) {
      return Response.json([{ job_id: JOB_ID, status: 'failed', run_id: RUN_ID }]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId: JOB_ID, claimToken: CLAIM_TOKEN, runId: RUN_ID,
          appStoreId: '123456789', country: 'kr',
        }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'cluster_validation_required');
    assert.doesNotMatch(text, /SUPABASE|SERVICE_ROLE|do-not-leak/i);
    assert.equal(calls.length, 2);
    const completion = JSON.parse(calls[1].body);
    assert.equal(completion.p_status, 'failed');
    assert.equal(completion.p_job_id, JOB_ID);
    assert.equal(completion.p_claim_token, CLAIM_TOKEN);
  } finally { globalThis.fetch = originalFetch; }
});

test('database and auth upstream failures use a safe retryable envelope', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const missingEnv = await workerModule.default.fetch(new Request('https://worker.example/api/health'), {});
    const missingEnvText = await missingEnv.text();
    assert.equal(missingEnv.status, 500);
    assert.doesNotMatch(missingEnvText, /SUPABASE|SERVICE_ROLE|ANON_KEY/i);

    globalThis.fetch = async () => { throw new Error('SUPABASE_SERVICE_ROLE_KEY=secret network failure'); };
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/runs?appId=123456789&country=kr'),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(response.status, 502);
    assert.deepEqual(Object.keys(payload).sort(), ['error', 'message', 'ok', 'requestId', 'retryable']);
    assert.equal(payload.error, 'upstream_unavailable');
    assert.equal(payload.retryable, true);
    assert.doesNotMatch(text, /SUPABASE|SERVICE_ROLE|secret network/i);

    const authResponse = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', { headers: { Authorization: 'Bearer user-token' } }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    assert.equal(authResponse.status, 502);
    assert.equal((await authResponse.json()).error, 'upstream_unavailable');
  } finally { globalThis.fetch = originalFetch; }
});

test('account deletion distinguishes cancellation failure from auth deletion failure', async () => {
  const originalFetch = globalThis.fetch;
  const userId = '11111111-1111-4111-8111-111111111111';
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
  };
  try {
    let deleteCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: userId });
      if (url.endsWith('/rest/v1/rpc/prepare_account_deletion')) {
        return Response.json({ code: 'XX000', message: 'private' }, { status: 500 });
      }
      if (url.includes('/auth/v1/admin/users/')) deleteCalls += 1;
      return Response.json({});
    };
    const notStarted = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/account', {
        method: 'DELETE', headers: { Authorization: 'Bearer user-token' },
      }), env,
    );
    assert.equal(notStarted.status, 502);
    assert.equal((await notStarted.json()).error, 'account_delete_not_started');
    assert.equal(deleteCalls, 0);

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: userId });
      if (url.endsWith('/rest/v1/rpc/prepare_account_deletion')) {
        return Response.json([{ canceled_jobs: 1, redacted_jobs: 2 }]);
      }
      if (url.includes('/auth/v1/admin/users/')) {
        deleteCalls += 1;
        return Response.json({ message: 'private' }, { status: 503 });
      }
      return Response.json({ code: 'unexpected' }, { status: 500 });
    };
    const incomplete = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/account', {
        method: 'DELETE', headers: { Authorization: 'Bearer user-token' },
      }), env,
    );
    const incompletePayload = await incomplete.json();
    assert.equal(incomplete.status, 502);
    assert.equal(incompletePayload.error, 'account_delete_incomplete');
    assert.match(incompletePayload.message, /요청 취소와 메모 삭제는 완료/);
    assert.match(incompletePayload.message, /계정 삭제 결과는 확인하지 못했습니다/);
    assert.equal(deleteCalls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('private job history replaces legacy raw error messages with a safe status message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    if (url.includes('/rest/v1/pipeline_jobs?')) {
      return Response.json([
        {
          id: JOB_ID,
          status: 'failed',
          error_message: 'SUPABASE_SERVICE_ROLE_KEY=legacy-secret raw upstream body',
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          status: 'failed',
          error_message: 'review_scope_incomplete',
        },
      ]);
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', { headers: { Authorization: 'Bearer user-token' } }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(text, /SUPABASE|SERVICE_ROLE|legacy-secret|raw upstream/i);
    const jobs = JSON.parse(text).data;
    assert.match(jobs[0].error_message, /다시 요청/);
    assert.equal(jobs[0].failure_code, null);
    assert.equal(jobs[1].failure_code, 'review_scope_incomplete');
    assert.match(jobs[1].error_message, /수집 한도/);
  } finally { globalThis.fetch = originalFetch; }
});

test('review pagination uses an opaque reviewed_at plus review_id cursor', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const reviewedAt = '2026-07-20T00:00:00.000Z';
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return Response.json([
        { review_id: '3', reviewed_at: reviewedAt, rating: 3, summary: 'a', content: 'a' },
        { review_id: '2', reviewed_at: reviewedAt, rating: 3, summary: 'b', content: 'b' },
        { review_id: '1', reviewed_at: reviewedAt, rating: 3, summary: 'c', content: 'c' },
      ]);
    }
    return Response.json([]);
  };
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
  };
  try {
    const first = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&country=kr&limit=2'), env,
    );
    const firstPayload = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstPayload.data.length, 2);
    assert.ok(firstPayload.nextCursor);

    const second = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&country=kr&limit=2&cursor='
        + encodeURIComponent(firstPayload.nextCursor)), env,
    );
    assert.equal(second.status, 200);
    const secondUrl = new URL(urls[1]);
    assert.equal(secondUrl.searchParams.get('order'), 'reviewed_at.desc,review_id.desc');
    assert.match(secondUrl.searchParams.get('or') || '', /reviewed_at\.eq\./);
    assert.match(secondUrl.searchParams.get('or') || '', /review_id\.lt\.2/);

    const malformed = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&cursor=not-a-cursor'), env,
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invalid_request');

    const legacy = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&cursor='
        + encodeURIComponent(reviewedAt)), env,
    );
    const legacyPayload = await legacy.json();
    assert.equal(legacy.status, 400);
    assert.equal(legacyPayload.error, 'legacy_cursor_unsupported');
    assert.match(legacyPayload.message, /cursor.*제거.*첫 페이지/);
    assert.equal(urls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('public review filters opt into a shared date window and content-only search without changing broad defaults', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json([]);
  };
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
  };
  try {
    const scoped = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&country=kr'
        + '&from=2026-06-29T08%3A00%3A00.000Z&to=2026-07-29T08%3A00%3A00.000Z'
        + '&search=needle&searchScope=content'), env,
    );
    const compatible = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&country=kr&search=needle'), env,
    );
    const cursor = Buffer.from(JSON.stringify({
      reviewedAt: '2026-07-20T00:00:00.000Z', reviewId: 'review-2',
    })).toString('base64url');
    const nextPage = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789&country=kr'
        + '&from=2026-06-29T08%3A00%3A00.000Z&search=needle&searchScope=content'
        + `&cursor=${encodeURIComponent(cursor)}`), env,
    );
    assert.equal(scoped.status, 200, await scoped.clone().text());
    assert.equal(compatible.status, 200, await compatible.clone().text());
    assert.equal(nextPage.status, 200, await nextPage.clone().text());

    const scopedUrl = new URL(urls[0]);
    assert.deepEqual(scopedUrl.searchParams.getAll('reviewed_at'), [
      'gte.2026-06-29T08:00:00.000Z',
      'lte.2026-07-29T08:00:00.000Z',
    ]);
    assert.equal(scopedUrl.searchParams.get('content'), 'ilike.*needle*');
    assert.equal(scopedUrl.searchParams.has('or'), false);

    const compatibleUrl = new URL(urls[1]);
    const broadSearch = compatibleUrl.searchParams.get('or') || '';
    assert.match(broadSearch, /summary\.ilike\.\*needle\*/);
    assert.match(broadSearch, /issue_label\.ilike\.\*needle\*/);
    assert.match(broadSearch, /reason_summary\.ilike\.\*needle\*/);
    assert.match(broadSearch, /action_hint\.ilike\.\*needle\*/);
    assert.equal(compatibleUrl.searchParams.has('content'), false);
    assert.equal(compatibleUrl.searchParams.has('reviewed_at'), false);

    const nextPageUrl = new URL(urls[2]);
    const combinedFilter = nextPageUrl.searchParams.get('and') || '';
    assert.match(combinedFilter, /reviewed_at\.eq\.2026-07-20T00:00:00\.000Z/);
    assert.match(combinedFilter, /review_id\.lt\.review-2/);
    assert.match(combinedFilter, /content\.ilike\.\*needle\*/);
    assert.equal(nextPageUrl.searchParams.get('reviewed_at'), 'gte.2026-06-29T08:00:00.000Z');
    assert.equal(nextPageUrl.searchParams.has('content'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('public run and app lists query and return published runs only', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/rest/v1/rpc/get_public_apps') {
      return Response.json([{
        app_store_id: '123456789', country: 'kr', app_name: 'Published app',
        updated_at: '2026-07-26T00:00:00.000Z',
      }]);
    }
    if (url.pathname === '/rest/v1/pipeline_runs') {
      if ((url.searchParams.get('select') || '').includes('run_id')) {
        return Response.json([{ run_id: 'published-run', app_store_id: '123456789', country: 'kr', status: 'published' }]);
      }
      return Response.json([{
        app_store_id: '123456789', country: 'kr', status: 'published', review_count: 5,
        published_at: '2026-07-26T00:00:00.000Z',
      }]);
    }
    if (url.pathname === '/rest/v1/apps' && url.searchParams.has('or')) {
      return Response.json([
        { app_store_id: '123456789', country: 'kr', app_name: 'Published app' },
        { app_store_id: '999999999', country: 'kr', app_name: 'Unpublished app' },
      ]);
    }
    if (url.pathname === '/rest/v1/apps') return Response.json([{ app_name: 'Published app' }]);
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  const env = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
  };

  try {
    const runs = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/runs?appId=123456789&country=kr'), env,
    );
    assert.equal(runs.status, 200, await runs.clone().text());

    const apps = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/apps?limit=5'), env,
    );
    assert.equal(apps.status, 200, await apps.clone().text());

    const search = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/apps/search?q=app&limit=5'), env,
    );
    const searchPayload = await search.json();
    assert.equal(search.status, 200);
    assert.deepEqual(searchPayload.data.map((row) => row.app_store_id), ['123456789']);

    const appDirectoryCalls = calls.filter(({ url }) => url.pathname === '/rest/v1/rpc/get_public_apps');
    assert.equal(appDirectoryCalls.length, 1);
    assert.equal(appDirectoryCalls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(appDirectoryCalls[0].init.body)), { p_limit: 5 });

    const runCalls = calls.filter(({ url }) => url.pathname === '/rest/v1/pipeline_runs');
    assert.ok(runCalls.length >= 2);
    for (const { url } of runCalls) {
      assert.equal(url.searchParams.get('status'), 'eq.published');
      assert.doesNotMatch(url.search, /upserted/i);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('public app directory keeps the 100-app contract to one Supabase request', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || 'GET', body: String(init.body || '') });
    return Response.json(Array.from({ length: 100 }, (_, index) => ({
      app_store_id: String(1_000_000_000 + index),
      country: index % 2 === 0 ? 'kr' : 'us',
      app_name: `App ${index}`,
      updated_at: new Date(Date.UTC(2026, 6, 29, 0, 0, 100 - index)).toISOString(),
    })));
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/apps?limit=100'),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.length, 100);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/get_public_apps$/);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body), { p_limit: 100 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('queue creation succeeds when the optional n8n trigger has a network failure', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: String(init.body || '') });
    if (url === 'https://n8n.example/webhook/queue') throw new Error('private downstream detail');
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && method === 'GET') return Response.json([]);
    if (url.includes('itunes.apple.com/lookup?')) return Response.json({
      results: [{ trackId: 123456789, trackName: '검증된 앱', wrapperType: 'software' }],
    });
    if (url.endsWith('/rest/v1/rpc/enqueue_pipeline_job') && method === 'POST') {
      return Response.json({
        result: 'queued',
        data: {
          id: JOB_ID,
          app_store_id: '123456789',
          country: 'kr',
          app_name: '검증된 앱',
          status: 'queued',
          stage: 'queued',
          run_id: null,
          requested_at: '2026-07-29T00:00:00.000Z',
          updated_at: '2026-07-29T00:00:00.000Z',
        },
      });
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/private/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        N8N_PIPELINE_TRIGGER_URL: 'https://n8n.example/webhook/queue',
        N8N_PIPELINE_TRIGGER_SECRET: 'trigger-secret',
        APPLE_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      },
    );
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(response.status, 201, text);
    assert.equal(payload.result, 'queued');
    assert.deepEqual(payload.trigger, { dispatched: false });
    assert.doesNotMatch(text, /private downstream|trigger-secret|n8n\.example/i);
    assert.ok(calls.some((call) => call.url === 'https://n8n.example/webhook/queue'));
  } finally { globalThis.fetch = originalFetch; }
});

test('only the measured large persistence RPCs use one 60 second database attempt', () => {
  const source = readFileSync(resolve(testDir, '../internal.ts'), 'utf8');
  assert.match(
    source,
    /\/rest\/v1\/rpc\/persist_pipeline_reviews'[\s\S]{0,900}?timeoutMs:\s*60_000,[\s\S]{0,80}?retries:\s*0/,
  );
  assert.match(
    source,
    /\/rest\/v1\/rpc\/persist_issue_clusters'[\s\S]{0,900}?timeoutMs:\s*60_000,[\s\S]{0,80}?retries:\s*0/,
  );
  assert.equal(source.match(/timeoutMs:\s*60_000/g)?.length, 2);
});

test('pipeline stabilization SQL keeps lease, transaction, staging, and privilege contracts in parity', () => {
  const migration = readFileSync(resolve(testDir, '../../../../supabase/migrations/202607260001_pipeline_stabilization.sql'), 'utf8');
  const schema = readFileSync(resolve(testDir, '../../../../supabase/schema.sql'), 'utf8');
  const workerSource = workerModulePaths.map((file) => readFileSync(file, 'utf8')).join('\n');

  for (const [name, sql] of [['migration', migration], ['schema', schema]]) {
    const functionSql = (functionName) => {
      const start = sql.toLowerCase().lastIndexOf(`create or replace function public.${functionName.toLowerCase()}(`);
      assert.notEqual(start, -1, `${name}: missing ${functionName}`);
      const end = sql.indexOf('\n$$;', start);
      assert.notEqual(end, -1, `${name}: unterminated ${functionName}`);
      return sql.slice(start, end + 4);
    };
    const claimSql = functionSql('claim_pipeline_job');
    const cancelSql = functionSql('cancel_pipeline_jobs');
    const completeSql = functionSql('complete_pipeline_job');
    const persistReviewsSql = functionSql('persist_pipeline_reviews');
    const publishSql = functionSql('publish_pipeline_run');
    const existingIdsSql = functionSql('get_existing_review_ids');
    const reviewsPolicyStart = sql.toLowerCase().lastIndexOf('create policy reviews_read_authenticated');
    assert.notEqual(reviewsPolicyStart, -1, `${name}: committed review policy`);
    const reviewsPolicySql = sql.slice(reviewsPolicyStart, sql.indexOf(';', reviewsPolicyStart) + 1);

    assert.match(sql, /add column if not exists claim_key text/i, name);
    assert.match(sql, /add column if not exists claim_token uuid/i, name);
    assert.match(sql, /lease_expires_at timestamptz/i, name);
    assert.match(sql, /last_heartbeat_at timestamptz/i, name);
    assert.match(sql, /attempt_count integer not null default 0/i, name);
    assert.match(sql, /create table if not exists public\.pipeline_job_claims/i, name);
    assert.match(sql, /alter table public\.pipeline_job_claims enable row level security/i, name);
    assert.match(sql, /revoke all on table public\.pipeline_job_claims from public, anon, authenticated/i, name);
    assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(normalized_claim_key, 0\)\)/i, name);
    assert.match(sql, /expired_job\.attempt_count >= 3[\s\S]*?status = 'failed'/i, name);
    assert.match(sql, /expired_job\.attempt_count < 3[\s\S]*?status = 'queued'/i, name);
    assert.match(sql, /pr\.status <> 'published'/i, name);
    assert.match(sql, /old\.requested_by is not null[\s\S]*?to_jsonb\(new\) - 'requested_by'/i, name);
    assert.match(sql, /create or replace function public\.persist_pipeline_reviews/i, name);
    assert.match(sql, /create or replace function public\.persist_issue_clusters/i, name);
    assert.match(sql, /create or replace function public\.publish_pipeline_run/i, name);
    assert.match(sql, /create or replace function public\.persist_pipeline_alerts/i, name);
    assert.match(sql, /create or replace function public\.record_pipeline_parse_error/i, name);
    assert.match(sql, /cluster review scope mismatch/i, name);
    assert.match(sql, /add column if not exists title text,[\s\S]*?add column if not exists model_version text/i, name);
    assert.match(sql, /select c\.id, s\.title, s\.category[\s\S]*?s\.last_seen_at[\s\S]*?s\.model_version/i, name);
    assert.match(sql, /grant execute on function public\.publish_pipeline_run[^;]+to service_role/i, name);
    assert.match(sql, /create table if not exists public\.pipeline_review_ai_staging/i, name);
    assert.match(sql, /alter table public\.pipeline_review_ai_staging enable row level security/i, name);
    assert.match(sql, /revoke all on table public\.pipeline_review_ai_staging from public, anon, authenticated/i, name);
    assert.match(
      reviewsPolicySql,
      /for select to authenticated[\s\S]*?using \([\s\S]*?exists \([\s\S]*?from public\.review_ai as committed_ai[\s\S]*?committed_ai\.review_id = reviews\.review_id/i,
      `${name}: staged raw reviews stay externally hidden`,
    );
    assert.doesNotMatch(reviewsPolicySql, /to anon|using \(true\)/i, name);
    assert.doesNotMatch(sql, /grant select on (table )?public\.reviews to anon/i, name);

    assert.match(
      claimSql,
      /for expired_job in[\s\S]*?from public\.pipeline_jobs as pj[\s\S]*?order by pj\.id asc[\s\S]*?for update of pj skip locked[\s\S]*?loop/i,
      `${name}: deterministic expired-job lock`,
    );
    assert.ok(
      claimSql.toLowerCase().indexOf('for update of pj skip locked')
        < claimSql.toLowerCase().indexOf('update public.pipeline_runs as pr'),
      `${name}: job row must be locked before the run row`,
    );
    assert.match(
      cancelSql,
      /from public\.pipeline_jobs as pj[\s\S]*?order by pj\.id asc[\s\S]*?for update/i,
      `${name}: bulk cancellation lock order`,
    );
    assert.match(
      persistReviewsSql,
      /join public\.reviews as existing[\s\S]*?existing\.app_store_id <> p_app_store_id[\s\S]*?existing\.country <> normalized_country[\s\S]*?errcode = '23514'/i,
      `${name}: cross-app review rejection`,
    );
    assert.ok(
      persistReviewsSql.indexOf('review already belongs to another app scope')
        < persistReviewsSql.indexOf('insert into public.pipeline_runs'),
      `${name}: cross-app check must precede persistence`,
    );
    assert.match(persistReviewsSql, /insert into public\.pipeline_review_ai_staging/i, name);
    assert.doesNotMatch(persistReviewsSql, /insert into public\.review_ai\s*\(/i, name);
    assert.match(persistReviewsSql, /insert into public\.apps[\s\S]*?values \(p_app_store_id, normalized_country, null, now\(\)\)/i, name);
    assert.match(persistReviewsSql, /on conflict \(review_id\) do nothing/i, name);
    assert.match(
      persistReviewsSql,
      /on conflict \(review_id\) do nothing;[\s\S]*?left join public\.reviews as persisted[\s\S]*?review scope changed during persistence[\s\S]*?insert into public\.pipeline_review_ai_staging/i,
      `${name}: post-conflict scope recheck`,
    );
    assert.match(
      persistReviewsSql,
      /group by incoming\.review_id[\s\S]*?count\(\*\) > 1[\s\S]*?errcode = '23514'[\s\S]*?review ids must be nonempty and unique/i,
      `${name}: duplicate review rejection`,
    );
    assert.match(sql, /create unique index if not exists uq_reviews_id_scope[\s\S]*?review_id, app_store_id, country/i, name);
    assert.match(
      sql,
      /foreign key \(review_id, app_store_id, country\)[\s\S]*?references public\.reviews \(review_id, app_store_id, country\)/i,
      name,
    );
    for (const column of ['rating', 'author', 'content', 'reviewed_at', 'raw_source']) {
      assert.match(persistReviewsSql, new RegExp(`insert into public\\.pipeline_review_ai_staging[\\s\\S]*?${column}`, 'i'), `${name}: staged ${column}`);
    }
    assert.match(existingIdsSql, /join public\.review_ai as ai/i, name);
    assert.doesNotMatch(existingIdsSql, /pipeline_review_ai_staging/i, name);
    assert.match(publishSql, /insert into public\.review_ai[\s\S]*?from public\.pipeline_review_ai_staging/i, name);
    assert.match(
      publishSql,
      /update public\.reviews as review[\s\S]*?rating = staging\.rating[\s\S]*?raw_source = staging\.raw_source[\s\S]*?insert into public\.review_ai/i,
      `${name}: raw and AI publish atomically`,
    );
    assert.ok(
      publishSql.indexOf('insert into public.review_ai') < publishSql.indexOf("set status = 'published'"),
      `${name}: staged AI merge must share the publication transaction`,
    );
    assert.match(publishSql, /update public\.apps as app[\s\S]*?job\.app_name/i, name);
    assert.match(
      completeSql,
      /normalized_status = 'completed'[\s\S]*?pipeline_review_ai_staging[\s\S]*?pr\.status <> 'published'[\s\S]*?pr\.app_store_id <> current_job\.app_store_id[\s\S]*?pr\.country <> current_job\.country[\s\S]*?errcode = '23514'/i,
      `${name}: direct completion invariant`,
    );
    assert.doesNotMatch(sql, /^\s*(commit|rollback)\b/im, name);
  }

  assert.doesNotMatch(workerSource, /fallbackRows|RPC가 실패\/0건이어도 직접 PATCH/i);
  assert.match(workerSource, /\/rest\/v1\/rpc\/persist_pipeline_reviews/);
  assert.match(workerSource, /\/rest\/v1\/rpc\/persist_issue_clusters/);
  assert.match(workerSource, /\/rest\/v1\/rpc\/publish_pipeline_run/);
  assert.match(workerSource, /pipeline_runs\?select=run_id,[^`]+status=eq\.published/i);
  assert.match(workerSource, /pipeline_runs\?select=app_store_id,[^`]+status=eq\.published/i);
  assert.doesNotMatch(workerSource, /status=in\.\(upserted,published\)/i);
  assert.match(workerSource, /legacy_cursor_unsupported/);
  assert.match(workerSource, /pipeline_completion_rejected/);
  assert.match(workerSource, /status: 'failed'[\s\S]{0,300}pipeline_review_rejected/);
  assert.match(workerSource, /upstreamCode\?\.startsWith\('22'\)[\s\S]*?startsWith\('23'\)[\s\S]*?upstreamCode === '21000'/);
  assert.match(workerSource, /Number\.isInteger\(rating\)[\s\S]*?rating < 1 \|\| rating > 5/);
  assert.match(workerSource, /new Date\(reviewedAt\)\.getTime\(\)/);
  assert.match(workerSource, /confidence < 0 \|\| confidence > 1/);
  assert.doesNotMatch(workerSource, /Accept timestamp-only cursors/i);
  assert.match(workerSource, /\/rest\/v1\/rpc\/get_pipeline_review_scope/);
  assert.match(workerSource, /p_review_ids:\s*reviewIds[\s\S]{0,120}p_include_analysis:\s*includeAnalysis/);
  assert.doesNotMatch(workerSource, /\/rest\/v1\/rpc\/get_existing_review_ids/);
  assert.doesNotMatch(workerSource, /private_review_feed\?[\s\S]{0,300}review_id=in/i);
});
