import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let tempDir;
let workerModule;

test.before(async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  tempDir = await mkdtemp(join(tmpdir(), 'voc-radar-private-job-quota-'));
  const outfile = join(tempDir, 'worker.mjs');
  await build({
    entryPoints: [resolve(testDir, '../index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
  });
  workerModule = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
});

test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const USER_ID = '11111111-1111-4111-8111-111111111111';
const allowAppleLookup = { limit: async () => ({ success: true }) };
const baseEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
  API_RETRY_COUNT: '0',
  APPLE_LOOKUP_RATE_LIMITER: allowAppleLookup,
};

function queueRequest(extra = {}) {
  return new Request('https://worker.example/api/private/jobs', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      appStoreId: '123456789',
      country: 'kr',
      appName: '클라이언트 이름',
      dailyLimit: 99,
      ...extra,
    }),
  });
}

function installQueueFetch({
  freshRun = null,
  activeJobs = [],
  recentUserJobs = [],
  appleResponse = Response.json({
    results: [{ trackId: 123456789, trackName: '검증된 이름', wrapperType: 'software' }],
  }),
  enqueueResponse = Response.json({
    result: 'queued',
    data: {
      id: 'job-new',
      app_store_id: '123456789',
      country: 'kr',
      app_name: '검증된 이름',
      status: 'queued',
      stage: 'queued',
      requested_at: '2026-07-29T00:00:00.000Z',
      note: null,
      source: 'web',
      error_message: null,
      started_at: null,
      finished_at: null,
      created_at: '2026-07-29T00:00:00.000Z',
      requested_by: 'private-user',
      claim_token: 'private-claim',
    },
  }),
} = {}) {
  const calls = [];
  const rpcBodies = [];
  let activeIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = init.method || 'GET';
    calls.push({ url, method });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: USER_ID });
    if (url.includes('/rest/v1/pipeline_runs?')) {
      return Response.json(freshRun ? [freshRun] : []);
    }
    if (url.includes('/rest/v1/pipeline_jobs?') && method === 'GET') {
      const status = parsed.searchParams.get('status') || '';
      if (status === 'eq.completed') return Response.json([]);
      if (status === 'in.(queued,running)') {
        const rows = Array.isArray(activeJobs[0]) ? activeJobs[activeIndex++] || [] : activeJobs;
        return Response.json(rows);
      }
      if (parsed.searchParams.get('requested_by')) return Response.json(recentUserJobs);
    }
    if (url.includes('itunes.apple.com/lookup?')) return appleResponse;
    if (url.endsWith('/rest/v1/rpc/enqueue_pipeline_job') && method === 'POST') {
      rpcBodies.push(JSON.parse(String(init.body)));
      return enqueueResponse;
    }
    return Response.json({ code: 'unexpected' }, { status: 500 });
  };
  return { calls, originalFetch, rpcBodies };
}

for (const [configured, expected] of [
  [undefined, 10],
  ['0', 1],
  ['101', 100],
  ['4.9', 4],
  ['invalid', 10],
]) {
  test(`queue uses the server-owned clamped daily limit (${String(configured)})`, async () => {
    const { calls, originalFetch, rpcBodies } = installQueueFetch();
    try {
      const env = { ...baseEnv };
      if (configured !== undefined) env.USER_JOB_DAILY_LIMIT = configured;
      const response = await workerModule.default.fetch(queueRequest(), env);
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal(rpcBodies.length, 1);
      assert.deepEqual(rpcBodies[0], {
        p_app_store_id: '123456789',
        p_country: 'kr',
        p_app_name: '검증된 이름',
        p_note: null,
        p_requested_by: USER_ID,
        p_daily_limit: expected,
      });
      const payload = await response.json();
      assert.equal(payload.result, 'queued');
      for (const privateKey of ['note', 'source', 'requested_by', 'claim_token']) {
        assert.equal(Object.hasOwn(payload.data, privateKey), false);
      }
      assert.equal(calls.some((call) => call.url.includes('dailyLimit')), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('quota preflight rejects before the Apple lookup without replacing the transactional check', async () => {
  const { calls, originalFetch, rpcBodies } = installQueueFetch({
    recentUserJobs: [
      { requested_at: '2026-07-29T00:00:00.000Z' },
      { requested_at: '2026-07-29T01:00:00.000Z' },
    ],
  });
  try {
    let limiterCalls = 0;
    const response = await workerModule.default.fetch(queueRequest(), {
      ...baseEnv,
      USER_JOB_DAILY_LIMIT: '2',
      APPLE_LOOKUP_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
    });
    assert.equal(response.status, 429, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.error, 'job_daily_limit_reached');
    assert.match(payload.message, /대기열에 추가되지 않았습니다/);
    assert.match(payload.message, /다시 요청/);
    assert.equal(calls.some((call) => call.url.includes('itunes.apple.com')), false);
    assert.equal(limiterCalls, 0);
    assert.deepEqual(rpcBodies, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transactional quota rejection maps to a safe 429 response', async () => {
  const { originalFetch } = installQueueFetch({
    enqueueResponse: Response.json({ result: 'quota_exceeded', retryAt: '2026-07-30T00:00:00.000Z' }),
  });
  try {
    const response = await workerModule.default.fetch(queueRequest(), baseEnv);
    assert.equal(response.status, 429, await response.clone().text());
    const text = await response.text();
    assert.match(text, /job_daily_limit_reached/);
    assert.match(text, /대기열에 추가되지 않았습니다/);
    assert.doesNotMatch(text, /retryAt|service-role|PGRST|pipeline_jobs/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fresh and existing fast paths do not run quota preflight or enqueue', async () => {
  for (const scenario of [
    {
      freshRun: { run_id: 'run-fresh', published_at: new Date().toISOString() },
      expected: 'fresh',
    },
    {
      activeJobs: [{
        id: 'job-active',
        app_store_id: '123456789',
        country: 'kr',
        status: 'queued',
        requested_at: '2026-07-29T00:00:00.000Z',
        note: 'private cross-user note',
        source: 'reanalysis',
      }],
      expected: 'existing',
    },
  ]) {
    const { calls, originalFetch, rpcBodies } = installQueueFetch(scenario);
    try {
      let limiterCalls = 0;
      const response = await workerModule.default.fetch(queueRequest(), {
        ...baseEnv,
        APPLE_LOOKUP_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
      });
      assert.equal(response.status, 200, await response.clone().text());
      const payload = await response.json();
      assert.equal(payload.result, scenario.expected);
      if (payload.data) {
        assert.equal(Object.hasOwn(payload.data, 'note'), false);
        assert.equal(Object.hasOwn(payload.data, 'source'), false);
      }
      assert.equal(calls.some((call) => new URL(call.url).searchParams.get('requested_by')), false);
      assert.equal(calls.some((call) => call.url.includes('itunes.apple.com')), false);
      assert.equal(limiterCalls, 0);
      assert.deepEqual(rpcBodies, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('Apple lookup limiter uses the authenticated user key before the external request', async () => {
  const keys = [];
  const { calls, originalFetch } = installQueueFetch();
  try {
    const response = await workerModule.default.fetch(queueRequest(), {
      ...baseEnv,
      APPLE_LOOKUP_RATE_LIMITER: {
        limit: async ({ key }) => { keys.push(key); return { success: true }; },
      },
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.deepEqual(keys, [`private-job-apple-lookup:${USER_ID}`]);
    assert.equal(calls.filter((call) => call.url.includes('itunes.apple.com')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Apple lookup limiter rejects repeated attempts before Apple or enqueue', async () => {
  const { calls, originalFetch, rpcBodies } = installQueueFetch();
  try {
    const response = await workerModule.default.fetch(queueRequest(), {
      ...baseEnv,
      APPLE_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    assert.equal(response.status, 429, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.error, 'job_request_rate_limited');
    assert.match(payload.message, /등록하지 않았습니다/);
    assert.match(payload.message, /1분 뒤 다시 요청/);
    assert.equal(calls.some((call) => call.url.includes('itunes.apple.com')), false);
    assert.deepEqual(rpcBodies, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing or failed Apple lookup limiter fails closed before Apple', async () => {
  for (const limiter of [undefined, { limit: async () => { throw new Error('binding unavailable'); } }]) {
    const { calls, originalFetch, rpcBodies } = installQueueFetch();
    try {
      const response = await workerModule.default.fetch(queueRequest(), {
        ...baseEnv,
        APPLE_LOOKUP_RATE_LIMITER: limiter,
      });
      assert.equal(response.status, 503, await response.clone().text());
      const payload = await response.json();
      assert.equal(payload.error, 'job_request_guard_unavailable');
      assert.equal(payload.retryable, true);
      assert.match(payload.message, /요청을 시작하지 않았습니다/);
      assert.equal(calls.some((call) => call.url.includes('itunes.apple.com')), false);
      assert.deepEqual(rpcBodies, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('RPC existing result never exposes cross-user or operator fields', async () => {
  const { originalFetch } = installQueueFetch({
    enqueueResponse: Response.json({
      result: 'existing',
      data: {
        id: 'job-operator',
        app_store_id: '123456789',
        country: 'kr',
        status: 'running',
        stage: 'extracting',
        requested_at: '2026-07-29T00:00:00.000Z',
        note: 'private operator note',
        source: 'reanalysis',
        requested_by: 'operator',
        claim_token: 'private-claim',
      },
    }),
  });
  try {
    const response = await workerModule.default.fetch(queueRequest(), baseEnv);
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.result, 'existing');
    assert.deepEqual(payload.data, {
      id: 'job-operator',
      app_store_id: '123456789',
      country: 'kr',
      status: 'running',
      stage: 'extracting',
      requested_at: '2026-07-29T00:00:00.000Z',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('malformed successful enqueue RPC data fails closed', async () => {
  for (const result of ['queued', 'existing']) {
    const { originalFetch } = installQueueFetch({
      enqueueResponse: Response.json({
        result,
        data: { id: 'job-malformed', app_store_id: '123456789', country: 'kr', status: 'queued' },
      }),
    });
    try {
      const response = await workerModule.default.fetch(queueRequest(), baseEnv);
      assert.equal(response.status, 500, await response.clone().text());
      const payload = await response.json();
      assert.equal(payload.error, 'job_queue_failed');
      assert.match(payload.message, /요청은 시작되지 않았습니다/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('missing or forbidden enqueue RPC stays a safe 503', async () => {
  for (const enqueueResponse of [
    Response.json({ code: 'PGRST202', message: 'private schema cache detail' }, { status: 404 }),
    Response.json({ code: '42501', message: 'private privilege detail' }, { status: 403 }),
  ]) {
    const { originalFetch } = installQueueFetch({ enqueueResponse });
    try {
      const response = await workerModule.default.fetch(queueRequest(), baseEnv);
      assert.equal(response.status, 503, await response.clone().text());
      const text = await response.text();
      assert.match(text, /job_queue_unavailable/);
      assert.doesNotMatch(text, /PGRST202|42501|schema cache|privilege/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('unique active-app race still recovers the existing safe job view', async () => {
  const existing = {
    id: 'job-raced',
    app_store_id: '123456789',
    country: 'kr',
    status: 'queued',
    stage: 'queued',
    requested_at: '2026-07-29T00:00:00.000Z',
    note: 'private raced note',
    source: 'reanalysis',
  };
  const { originalFetch } = installQueueFetch({
    activeJobs: [[], [existing]],
    enqueueResponse: Response.json({ code: '23505', message: 'private unique detail' }, { status: 409 }),
  });
  try {
    const response = await workerModule.default.fetch(queueRequest(), baseEnv);
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.result, 'existing');
    assert.equal(payload.data.id, 'job-raced');
    assert.equal(Object.hasOwn(payload.data, 'note'), false);
    assert.equal(Object.hasOwn(payload.data, 'source'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
