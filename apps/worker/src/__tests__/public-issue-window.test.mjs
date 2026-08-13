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
  tempDir = await mkdtemp(join(tmpdir(), 'voc-radar-issue-window-'));
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

test('issue detail fails closed without database access when detail views are disabled', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ error: 'unexpected database access' }, { status: 500 });
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues/11111111-1111-4111-8111-111111111111'),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key',
        PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
        DETAIL_VIEW_ENABLED: 'false',
      },
    );

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'detail_view_disabled');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy dashboard fails closed before cache or database access when detail views are disabled', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  let fetchCalls = 0;
  let cacheCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ error: 'unexpected database access' }, { status: 500 });
  };
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      async open() {
        cacheCalls += 1;
        throw new Error('unexpected cache access');
      },
    },
  });

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/dashboard?appId=123456789&country=kr'),
      {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: 'anon-key',
        PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
        DETAIL_VIEW_ENABLED: 'false',
      },
    );

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'detail_view_disabled');
    assert.equal(cacheCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else Reflect.deleteProperty(globalThis, 'caches');
  }
});

test('report, V2 issues, and issue detail use the current requested review window', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const cacheEntries = new Map();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      async open() {
        return {
          async match(input) {
            return cacheEntries.get(typeof input === 'string' ? input : input.url)?.clone();
          },
          async put(input, response) {
            cacheEntries.set(typeof input === 'string' ? input : input.url, response.clone());
          },
        };
      },
    },
  });

  const issueBodies = [];
  const detailBodies = [];
  const aggregateBodies = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/rest/v1/rpc/get_public_issue_clusters_windowed')) {
      issueBodies.push(JSON.parse(String(init.body)));
      return Response.json([{
        issue_id: '22222222-2222-4222-8222-222222222222',
        title: '대표 이슈',
        review_count: 4,
        evidence_count: 4,
        total_count: 73,
      }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_public_issue_detail_windowed')) {
      detailBodies.push(JSON.parse(String(init.body)));
      return Response.json({ issue: {}, reviews: [] });
    }
    if (url.endsWith('/rest/v1/rpc/get_public_overview')) {
      aggregateBodies.push(JSON.parse(String(init.body)));
      return Response.json([{}]);
    }
    if (url.endsWith('/rest/v1/rpc/get_public_categories')
      || url.endsWith('/rest/v1/rpc/get_public_trends')) {
      aggregateBodies.push(JSON.parse(String(init.body)));
      return Response.json([]);
    }
    if (url.includes('/rest/v1/pipeline_runs?')) return Response.json([]);
    if (url.includes('/rest/v1/apps?')) return Response.json([]);
    if (url.includes('itunes.apple.com/lookup?')) return Response.json({ results: [] });
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };

  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key',
    PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
    API_RETRY_COUNT: '0',
    REPORT_V2_ENABLED: 'true',
  };
  const from = '2026-06-30T00:00:00.000Z';
  const to = '2026-07-30T00:00:00.000Z';
  const query = `appId=1018769995&country=kr&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  try {
    const report = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/report?${query}`),
      env,
    );
    const issues = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/issues?${query}`),
      env,
    );
    const beforeDefaultWindow = Date.now();
    const defaultReport = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/report?appId=1018769996&country=kr'),
      env,
    );
    const defaultIssues = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues?appId=1018769995&country=kr'),
      env,
    );
    const afterDefaultWindow = Date.now();
    const beforeDetail = Date.now();
    const detail = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues/11111111-1111-4111-8111-111111111111'),
      env,
    );
    const afterDetail = Date.now();

    assert.equal(report.status, 200, await report.clone().text());
    assert.equal(issues.status, 200, await issues.clone().text());
    assert.equal(defaultReport.status, 200, await defaultReport.clone().text());
    assert.equal(defaultIssues.status, 200, await defaultIssues.clone().text());
    assert.equal(detail.status, 200, await detail.clone().text());
    const reportPayload = await report.clone().json();
    const defaultReportPayload = await defaultReport.clone().json();
    assert.equal(reportPayload.data.summary.issueCount, 73);
    assert.deepEqual(reportPayload.data.window, { from, to });
    assert.equal((await issues.clone().json()).data.length, 1);
    assert.equal(issueBodies.length, 4);
    for (const body of issueBodies.slice(0, 2)) {
      assert.equal(body.p_from, from);
      assert.equal(body.p_to, to);
    }
    assert.equal(aggregateBodies.length, 6);
    for (const body of aggregateBodies.slice(0, 3)) {
      assert.equal(body.p_from, from);
      assert.equal(body.p_to, to);
    }
    for (const body of issueBodies.slice(2)) {
      const defaultFrom = Date.parse(body.p_from);
      const defaultTo = Date.parse(body.p_to);
      assert.equal(defaultTo - defaultFrom, 30 * 24 * 60 * 60 * 1000 - 1);
      assert.equal((defaultTo + 1) % (24 * 60 * 60 * 1000), 0);
      assert.ok(
        defaultTo > beforeDefaultWindow
          && defaultTo <= afterDefaultWindow + 24 * 60 * 60 * 1000,
      );
    }
    for (const body of aggregateBodies.slice(3)) {
      assert.equal(body.p_from, issueBodies[2].p_from);
      assert.equal(body.p_to, issueBodies[2].p_to);
    }
    assert.deepEqual(defaultReportPayload.data.window, {
      from: issueBodies[2].p_from,
      to: issueBodies[2].p_to,
    });
    assert.equal(detailBodies.length, 1);
    const detailFrom = Date.parse(detailBodies[0].p_from);
    const detailTo = Date.parse(detailBodies[0].p_to);
    assert.equal(detailTo - detailFrom, 30 * 24 * 60 * 60 * 1000 - 1);
    assert.equal((detailTo + 1) % (24 * 60 * 60 * 1000), 0);
    assert.ok(detailTo > beforeDetail && detailTo <= afterDetail + 24 * 60 * 60 * 1000);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  }
});

test('report compatibility mode keeps legacy issue RPCs available while V2 is gated', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const cacheVersions = [];
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      async open() {
        return {
          async match(input) {
            cacheVersions.push(new URL(typeof input === 'string' ? input : input.url).searchParams.get('__cache_v'));
            return undefined;
          },
          async put() {},
        };
      },
    },
  });

  const listBodies = [];
  const detailBodies = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/rest/v1/rpc/get_public_issue_clusters')) {
      listBodies.push(JSON.parse(String(init.body)));
      return Response.json([{
        issue_id: '22222222-2222-4222-8222-222222222222',
        title: '기존 이슈',
        review_count: 4,
        evidence_count: 4,
      }]);
    }
    if (url.endsWith('/rest/v1/rpc/get_public_issue_detail')) {
      detailBodies.push(JSON.parse(String(init.body)));
      return Response.json({ issue: {}, reviews: [] });
    }
    if (url.endsWith('/rest/v1/rpc/get_public_overview')) return Response.json([{}]);
    if (url.endsWith('/rest/v1/rpc/get_public_categories') || url.endsWith('/rest/v1/rpc/get_public_trends')) {
      return Response.json([]);
    }
    if (url.includes('/rest/v1/pipeline_runs?') || url.includes('/rest/v1/apps?')) return Response.json([]);
    if (url.includes('itunes.apple.com/lookup?')) return Response.json({ results: [] });
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };

  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key',
    PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
    API_RETRY_COUNT: '0',
    REPORT_V2_ENABLED: 'false',
  };
  const window = 'from=2026-06-30T00%3A00%3A00.000Z&to=2026-07-30T00%3A00%3A00.000Z';

  try {
    const report = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/report?appId=1018769995&country=kr&${window}`),
      env,
    );
    const detail = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/issues/11111111-1111-4111-8111-111111111111?${window}`),
      env,
    );

    assert.equal(report.status, 200, await report.clone().text());
    assert.equal(detail.status, 200, await detail.clone().text());
    assert.equal((await report.json()).data.summary.issueCount, 1);
    assert.deepEqual(listBodies, [{ p_app_store_id: '1018769995', p_country: 'kr', p_limit: 50 }]);
    assert.deepEqual(detailBodies, [{ p_issue_id: '11111111-1111-4111-8111-111111111111' }]);
    assert.ok(cacheVersions.every((version) => version === '0:compat:window-v1'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  }
});

test('public issue surfaces reject incomplete, malformed, reversed, or oversized windows before database access', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ error: 'unexpected database access' }, { status: 500 });
  };
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key',
    PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
    REPORT_V2_ENABLED: 'true',
  };

  try {
    const incompleteReport = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/report?appId=1018769995'
        + '&from=2026-06-30T00%3A00%3A00.000Z'),
      env,
    );
    const malformedReport = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/report?appId=1018769995'
        + '&from=not-a-date&to=2026-07-30T00%3A00%3A00.000Z'),
      env,
    );
    const reversedIssues = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues?appId=1018769995'
        + '&from=2026-07-30T00%3A00%3A00.000Z&to=2026-06-30T00%3A00%3A00.000Z'),
      env,
    );
    const incompleteIssues = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues?appId=1018769995'
        + '&to=2026-07-30T00%3A00%3A00.000Z'),
      env,
    );
    const incompleteDetail = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues/11111111-1111-4111-8111-111111111111'
        + '?from=2026-06-30T00%3A00%3A00.000Z'),
      env,
    );
    const malformedDetail = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues/11111111-1111-4111-8111-111111111111?to=invalid'),
      env,
    );
    const oversizedWindow = 'from=2026-01-01T00%3A00%3A00.000Z&to=2026-04-02T00%3A00%3A00.001Z';
    const oversizedReport = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/report?appId=1018769995&${oversizedWindow}`),
      env,
    );
    const oversizedIssues = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/issues?appId=1018769995&${oversizedWindow}`),
      env,
    );
    const oversizedDetail = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/issues/11111111-1111-4111-8111-111111111111'
        + `?${oversizedWindow}`),
      env,
    );

    assert.equal(incompleteReport.status, 400);
    assert.equal(malformedReport.status, 400);
    assert.equal(reversedIssues.status, 400);
    assert.equal(incompleteIssues.status, 400);
    assert.equal(incompleteDetail.status, 400);
    assert.equal(malformedDetail.status, 400);
    assert.equal(oversizedReport.status, 400);
    assert.equal(oversizedIssues.status, 400);
    assert.equal(oversizedDetail.status, 400);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
