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
  tempDir = await mkdtemp(join(tmpdir(), 'voc-radar-private-app-name-'));
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

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
  API_RETRY_COUNT: '0',
  APPLE_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

function queueRequest(appName) {
  return new Request('https://worker.example/api/private/jobs', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
    body: JSON.stringify({ appStoreId: '123456789', country: 'kr', appName }),
  });
}

function installQueueFetch({ catalogResponse }) {
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: '11111111-1111-4111-8111-111111111111' });
    }
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/pipeline_jobs?') && method === 'GET') return Response.json([]);
    if (url.includes('itunes.apple.com/lookup?')) return catalogResponse;
    if (url.endsWith('/rest/v1/rpc/enqueue_pipeline_job') && method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push({ kind: 'enqueue', body });
      return Response.json({
        result: 'queued',
        data: {
          id: 'job-new',
          app_store_id: body.p_app_store_id,
          country: body.p_country,
          app_name: body.p_app_name,
          status: 'queued',
          stage: 'queued',
          requested_at: '2026-07-29T00:00:00.000Z',
        },
      });
    }
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };
  return { originalFetch, writes };
}

test('queue writes only the exact Apple catalog app name', async () => {
  const { originalFetch, writes } = installQueueFetch({
    catalogResponse: Response.json({
      results: [{ trackId: 123456789, trackName: '검증된 앱 이름', wrapperType: 'software' }],
    }),
  });

  try {
    const response = await workerModule.default.fetch(queueRequest('공개 이름 오염 시도'), env);
    assert.equal(response.status, 201, await response.clone().text());

    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, {
      p_app_store_id: '123456789',
      p_country: 'kr',
      p_app_name: '검증된 앱 이름',
      p_note: null,
      p_requested_by: '11111111-1111-4111-8111-111111111111',
      p_daily_limit: 10,
    });
    assert.doesNotMatch(JSON.stringify(writes), /공개 이름 오염 시도/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('queue rejects a matching non-software catalog identity before database writes', async () => {
  const { originalFetch, writes } = installQueueFetch({
    catalogResponse: Response.json({
      results: [{ trackId: 123456789, trackName: '동일 ID 음악', wrapperType: 'track' }],
    }),
  });

  try {
    const response = await workerModule.default.fetch(queueRequest('신뢰할 수 없는 이름'), env);
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).error, 'app_not_found');
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('queue preserves existing metadata when Apple verification is temporarily unavailable', async () => {
  const { originalFetch, writes } = installQueueFetch({
    catalogResponse: Response.json({ error: 'temporary outage' }, { status: 503 }),
  });

  try {
    const response = await workerModule.default.fetch(queueRequest('검증되지 않은 이름'), env);
    assert.equal(response.status, 201, await response.clone().text());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.p_app_name, null);
    assert.equal(writes[0].body.p_requested_by, '11111111-1111-4111-8111-111111111111');
    assert.doesNotMatch(JSON.stringify(writes), /검증되지 않은 이름/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
