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
    if (url.endsWith('/rest/v1/rpc/get_public_issue_clusters')) return Response.json([]);
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

    if (url.includes('/rest/v1/pipeline_jobs?')) {
      return new Response(JSON.stringify([{ id: 'job-1' }]), {
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
      },
    });
    assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/user');
    assert.equal(calls[1].method, 'PATCH');
    assert.match(calls[1].url, /\/rest\/v1\/pipeline_jobs\?/);
    assert.match(calls[1].url, new RegExp(`requested_by=eq\\.${userId}`));
    assert.equal(JSON.parse(calls[1].body).status, 'canceled');
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
      return Response.json([{ id: 'job-existing', app_store_id: '123456789', country: 'kr', status: 'running', stage: 'extracting' }]);
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
    calls.push({ url, method: init.method || 'GET', body: init.body ? String(init.body) : '' });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && (init.method || 'GET') === 'GET') return Response.json([]);
    if (url.includes('/rest/v1/apps?')) return Response.json([]);
    if (url.endsWith('/rest/v1/pipeline_jobs')) {
      const body = JSON.parse(String(init.body));
      return Response.json([{ id: 'job-new', ...body }]);
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
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.result, 'queued');
    assert.equal(payload.data.stage, 'queued');
    const insert = calls.find((call) => call.url.endsWith('/rest/v1/pipeline_jobs'));
    assert.equal(JSON.parse(insert.body).stage, 'queued');
  } finally { globalThis.fetch = originalFetch; }
});

test('forced reanalysis keeps existing reviews in the extraction stage', async () => {
  const originalFetch = globalThis.fetch;
  const jobId = '33333333-3333-4333-8333-333333333333';
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? String(init.body) : '' });
    if (url.endsWith('/rest/v1/rpc/get_existing_review_ids')) {
      return Response.json([{ review_id: 'review-existing' }]);
    }
    if (url.includes('/rest/v1/private_review_feed?')) {
      return Response.json([{
        review_id: 'review-existing',
        rating: 2,
        author: 'reviewer',
        content: '기존 리뷰',
        reviewed_at: '2026-07-20T00:00:00.000Z',
        priority: 'high',
        category: 'stability',
        summary: '앱이 종료됨',
      }]);
    }
    if (url.includes(`/rest/v1/pipeline_jobs?id=eq.${jobId}`) && method === 'PATCH') {
      return Response.json([]);
    }
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/filter-new-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          jobId,
          runId: 'run-reanalysis',
          appStoreId: '123456789',
          country: 'kr',
          forceReanalysis: true,
          reviews: [{
            reviewId: 'review-existing',
            author: 'reviewer',
            content: '기존 리뷰',
            rating: 2,
            reviewedAt: '2026-07-20T00:00:00.000Z',
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
    assert.equal(calls.some((call) => call.url.endsWith('/rest/v1/rpc/complete_pipeline_job')), false);
    const stageUpdate = calls.find((call) => call.url.includes('/rest/v1/pipeline_jobs?') && call.method === 'PATCH');
    assert.equal(JSON.parse(stageUpdate.body).stage, 'extracting');
  } finally { globalThis.fetch = originalFetch; }
});

test('cluster context only returns clusters from the latest published run', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/rest/v1/pipeline_runs?')) {
      return Response.json([{ run_id: 'run-latest' }]);
    }
    if (url.includes('/rest/v1/issue_clusters?')) {
      return Response.json([{
        id: '44444444-4444-4444-8444-444444444444',
        canonical_key: 'stability-crash',
        title: '앱 강제 종료',
        category: 'stability',
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-20T00:00:00.000Z',
      }]);
    }
    return Response.json({ error: `unexpected ${init.method || 'GET'} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/cluster-context', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({ appStoreId: '123456789', country: 'kr' }),
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
    assert.match(calls[0].url, /status=eq\.published/);
    assert.match(calls[0].url, /validation_status=eq\.passed/);
    assert.match(calls[1].url, /current_run_id=eq\.run-latest/);
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
    if (url.includes('/rest/v1/reviews?')) {
      return Response.json([{ review_id: 'review-1', reviewed_at: '2026-07-20T00:00:00.000Z' }]);
    }
    if (url.includes('/rest/v1/issue_clusters?select=') && method === 'GET') {
      return Response.json([{
        id: clusterId,
        canonical_key: 'stability-crash',
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-20T00:00:00.000Z',
        current_run_id: 'run-previous',
      }]);
    }
    if (url.includes('/rest/v1/issue_clusters?on_conflict=') && method === 'POST') {
      return Response.json([{ id: clusterId, canonical_key: 'stability-crash' }]);
    }
    if (url.includes('/rest/v1/issue_cluster_snapshots?on_conflict=') && method === 'POST') {
      return Response.json([]);
    }
    if (url.includes('/rest/v1/issue_cluster_reviews?') && method === 'DELETE') return Response.json([]);
    if (url.includes('/rest/v1/issue_cluster_reviews?on_conflict=') && method === 'POST') return Response.json([]);
    if (url.includes('/rest/v1/pipeline_runs?run_id=eq.') && method === 'PATCH') return Response.json([]);
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-clusters', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          runId: 'run-reanalysis',
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
    const snapshotInsert = calls.find((call) => call.url.includes('/rest/v1/issue_cluster_snapshots?on_conflict='));
    const [snapshot] = JSON.parse(snapshotInsert.body);
    assert.equal(snapshot.previous_review_count, null);
    assert.equal(snapshot.change_percent, null);
    assert.equal(snapshot.validation_result.comparisonEligible, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('validated publish advances cluster pointers after the run is published', async () => {
  const originalFetch = globalThis.fetch;
  const clusterId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? String(init.body) : '' });
    if (url.includes('/rest/v1/pipeline_runs?select=validation_status')) {
      return Response.json([{ validation_status: 'passed' }]);
    }
    if (url.includes('/rest/v1/issue_cluster_snapshots?select=cluster_id')) {
      return Response.json([{ cluster_id: clusterId }]);
    }
    if (url.includes('/rest/v1/pipeline_runs?run_id=eq.') && method === 'PATCH') return Response.json([]);
    if (url.includes('/rest/v1/issue_clusters?id=in.') && method === 'PATCH') return Response.json([]);
    return Response.json({ error: `unexpected ${method} ${url}` }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({ runId: 'run-published', appStoreId: '123456789', country: 'kr' }),
      }),
      {
        SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key', PIPELINE_WEBHOOK_SECRET: 'pipeline-secret', API_RETRY_COUNT: '0',
        REPORT_V2_ENABLED: 'true',
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const publishCall = calls.findIndex((call) => call.url.includes('/rest/v1/pipeline_runs?run_id=eq.') && call.method === 'PATCH');
    const pointerCall = calls.findIndex((call) => call.url.includes('/rest/v1/issue_clusters?id=in.') && call.method === 'PATCH');
    assert.ok(publishCall >= 0);
    assert.ok(pointerCall > publishCall);
    assert.equal(JSON.parse(calls[pointerCall].body).current_run_id, 'run-published');
  } finally { globalThis.fetch = originalFetch; }
});
