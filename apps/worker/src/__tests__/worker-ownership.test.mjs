import assert from 'node:assert/strict';
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let tempDir;
let workerModule;
let platformModule;
const testDir = dirname(fileURLToPath(import.meta.url));
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
};

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'voc-radar-worker-ownership-'));
  const outfile = join(tempDir, 'worker.mjs');
  const platformOutfile = join(tempDir, 'platform.mjs');
  await build({
    entryPoints: [resolve(testDir, '../index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
  });
  await build({
    entryPoints: [resolve(testDir, '../platform.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: platformOutfile,
  });
  workerModule = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  platformModule = await import(`${pathToFileURL(platformOutfile).href}?t=${Date.now()}`);
});

test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const internalRoutes = [
  'claim-job',
  'fetch-reviews',
  'job-status',
  'heartbeat',
  'filter-new-reviews',
  'upsert-reviews',
  'upsert-clusters',
  'cluster-context',
  'parse-error',
  'publish',
  'alert-events',
];

class CountingRequest extends Request {
  bodyReads = 0;

  async text() {
    this.bodyReads += 1;
    return super.text();
  }
}

test('known internal routes read the raw body once and authenticate before dispatch', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };

  try {
    for (const route of internalRoutes) {
      const request = new CountingRequest(`https://worker.example/api/internal/pipeline/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'wrong-secret' },
        body: '{"value":1}',
      });
      const response = await workerModule.default.fetch(request, env);
      assert.equal(response.status, 401, route);
      assert.equal((await response.json()).error, 'unauthorized', route);
      assert.equal(request.bodyReads, 1, route);
    }

    const unknown = new CountingRequest('https://worker.example/api/internal/pipeline/unknown', {
      method: 'POST',
      headers: { 'x-voc-token': 'wrong-secret' },
      body: '{"value":1}',
    });
    const unknownResponse = await workerModule.default.fetch(unknown, env);
    assert.equal(unknownResponse.status, 404);
    assert.equal(unknown.bodyReads, 0);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('direct token and timestamped HMAC formats remain accepted over the exact raw body', async () => {
  const tokenResponse = await workerModule.default.fetch(
    new Request('https://worker.example/api/internal/pipeline/job-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
      body: 'not-json',
    }),
    env,
  );
  assert.equal(tokenResponse.status, 400);
  assert.equal((await tokenResponse.json()).error, 'invalid_request');

  const rawBody = '{ "not": "normalized" }\n';
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.PIPELINE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const signature = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const signedRequest = (body) => new Request(
    'https://worker.example/api/internal/pipeline/job-status',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-voc-timestamp': timestamp,
        'x-voc-signature': signature,
      },
      body,
    },
  );

  const accepted = await workerModule.default.fetch(signedRequest(rawBody), env);
  assert.equal(accepted.status, 400);
  assert.equal((await accepted.json()).error, 'invalid_request');
  const altered = await workerModule.default.fetch(signedRequest(rawBody.trim()), env);
  assert.equal(altered.status, 401);
});

test('secret checks use the Workers timing-safe Web Crypto primitive when available', async () => {
  const original = crypto.subtle.timingSafeEqual;
  let comparisons = 0;
  crypto.subtle.timingSafeEqual = (left, right) => {
    comparisons += 1;
    return nodeTimingSafeEqual(Buffer.from(left), Buffer.from(right));
  };
  try {
    const accepted = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/job-status', {
        method: 'POST', headers: { 'x-voc-token': 'pipeline-secret' }, body: 'not-json',
      }),
      env,
    );
    const rejected = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/job-status', {
        method: 'POST', headers: { 'x-voc-token': 'short' }, body: 'not-json',
      }),
      env,
    );
    assert.equal(accepted.status, 400);
    assert.equal(rejected.status, 401);
    assert.equal(comparisons, 2);
  } finally {
    if (original) crypto.subtle.timingSafeEqual = original;
    else delete crypto.subtle.timingSafeEqual;
  }
});

test('invalid retry and timeout configuration falls back to finite bounded defaults', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays = [];
  globalThis.setTimeout = (_callback, delay) => {
    delays.push(delay);
    return 1;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async () => Response.json([]);

  try {
    for (const value of ['NaN', 'Infinity', '0', '2147483648', '1.5']) {
      delays.length = 0;
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/public/runs?appId=123456789'),
        { ...env, API_TIMEOUT_MS: value, API_RETRY_COUNT: '0' },
      );
      assert.equal(response.status, 200, value);
      assert.deepEqual(delays, [10_000], value);
    }

    delays.length = 0;
    const valid = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/runs?appId=123456789'),
      { ...env, API_TIMEOUT_MS: '250', API_RETRY_COUNT: '0' },
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(delays, [250]);

    delays.length = 0;
    const aboveDefault = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/runs?appId=123456789'),
      { ...env, API_TIMEOUT_MS: '10001', API_RETRY_COUNT: '0' },
    );
    assert.equal(aboveDefault.status, 200);
    assert.deepEqual(delays, [10_001]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  for (const value of ['NaN', 'Infinity', '-1', '9007199254740992', '1.5']) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ error: 'retry' }, { status: 500 });
    };
    try {
      const response = await workerModule.default.fetch(
        new Request('https://worker.example/api/public/runs?appId=123456789'),
        { ...env, API_TIMEOUT_MS: '250', API_RETRY_COUNT: value },
      );
      assert.equal(response.status, 502, value);
      assert.equal(calls, 3, value);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  let validRetryCalls = 0;
  globalThis.fetch = async () => {
    validRetryCalls += 1;
    return Response.json({ error: 'retry' }, { status: 500 });
  };
  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/runs?appId=123456789'),
      { ...env, API_TIMEOUT_MS: '250', API_RETRY_COUNT: '3' },
    );
    assert.equal(response.status, 502);
    assert.equal(validRetryCalls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('configured pipeline trigger fails closed when its required secret is absent', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ ok: true });
  };
  try {
    const result = await platformModule.triggerN8nPipeline(
      { ...env, N8N_PIPELINE_TRIGGER_URL: 'https://n8n.example/webhook/queue' },
      {
        jobId: '33333333-3333-4333-8333-333333333333',
        appStoreId: '123456789',
        country: 'kr',
        requestedAt: '2026-08-13T00:00:00.000Z',
      },
    );
    assert.deepEqual(result, {
      dispatched: false,
      reason: 'trigger_webhook_secret_not_configured',
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker alone derives persisted priority and filters alert rows to Critical', async () => {
  const originalFetch = globalThis.fetch;
  const persistedReviewPriorities = [];
  const persistedAlertRows = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/rest/v1/rpc/persist_pipeline_reviews')) {
      persistedReviewPriorities.push(body.p_reviews[0].priority);
      return Response.json([{ upserted_reviews: 1 }]);
    }
    if (url.endsWith('/rest/v1/rpc/persist_pipeline_alerts')) {
      persistedAlertRows.push(...body.p_alerts);
      return Response.json([{ inserted: body.p_alerts.length }]);
    }
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };
  const claim = {
    jobId: '33333333-3333-4333-8333-333333333333',
    claimToken: '66666666-6666-4666-8666-666666666666',
    runId: 'RUN_33333333-3333-4333-8333-333333333333_1',
  };

  try {
    const review = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/upsert-reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          ...claim,
          source: 'n8n',
          app: { appStoreId: '123456789', country: 'kr' },
          reviews: [{
            reviewId: 'review-1', rating: 1, author: 'author', content: 'content',
            reviewedAt: '2026-08-13T00:00:00.000Z', priority: 'Normal',
            category: '버그 및 성능', summary: 'summary',
          }],
        }),
      }),
      env,
    );
    const alert = await workerModule.default.fetch(
      new Request('https://worker.example/api/internal/pipeline/alert-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voc-token': 'pipeline-secret' },
        body: JSON.stringify({
          ...claim,
          appStoreId: '123456789',
          country: 'kr',
          alerts: [
            {
              reviewId: 'review-1', rating: 1, priority: 'Normal',
              category: '버그 및 성능', summary: 'summary',
            },
            {
              reviewId: 'review-2', rating: 5, priority: 'Normal',
              category: '긍정 리뷰 및 기타', summary: 'positive',
            },
          ],
        }),
      }),
      env,
    );
    assert.equal(review.status, 200, await review.clone().text());
    assert.equal(alert.status, 200, await alert.clone().text());
    assert.deepEqual(persistedReviewPriorities, ['Critical']);
    assert.deepEqual(
      persistedAlertRows.map(({ review_id, priority }) => ({ review_id, priority })),
      [{ review_id: 'review-1', priority: 'Critical' }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
