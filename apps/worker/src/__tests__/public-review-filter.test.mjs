import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let workerModule;
let tempDir;
const testDir = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(testDir, '../index.ts');
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_ANON_KEY: 'anon-key',
  PIPELINE_WEBHOOK_SECRET: 'pipeline-secret',
  API_RETRY_COUNT: '0',
  DETAIL_VIEW_ENABLED: 'true',
};

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'voc-radar-public-review-filter-test-'));
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

test('public reviews reject present invalid timestamp bounds before querying Supabase', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input) => {
    upstreamUrls.push(String(input));
    return Response.json([]);
  };

  try {
    for (const query of ['from=not-a-timestamp', 'to=']) {
      const response = await workerModule.default.fetch(
        new Request(`https://worker.example/api/public/reviews?appId=123456789&${query}`),
        env,
      );

      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'invalid_request');
    }
    assert.deepEqual(upstreamUrls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public reviews reject a reversed timestamp window before querying Supabase', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input) => {
    upstreamUrls.push(String(input));
    return Response.json([]);
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789'
        + '&from=2026-07-30T00%3A00%3A00.000Z&to=2026-07-29T00%3A00%3A00.000Z'),
      env,
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_request');
    assert.deepEqual(upstreamUrls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public reviews preserve omitted bounds and pass a valid window to Supabase', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input) => {
    upstreamUrls.push(String(input));
    return Response.json([]);
  };

  try {
    const omitted = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789'),
      env,
    );
    const bounded = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789'
        + '&from=2026-06-29T00%3A00%3A00.000Z&to=2026-07-29T00%3A00%3A00.000Z'),
      env,
    );

    assert.equal(omitted.status, 200, await omitted.clone().text());
    assert.equal(bounded.status, 200, await bounded.clone().text());
    assert.deepEqual(new URL(upstreamUrls[0]).searchParams.getAll('reviewed_at'), []);
    assert.deepEqual(new URL(upstreamUrls[1]).searchParams.getAll('reviewed_at'), [
      'gte.2026-06-29T00:00:00.000Z',
      'lte.2026-07-29T00:00:00.000Z',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public review search treats underscore as a literal in content-only and broad modes', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input) => {
    upstreamUrls.push(String(input));
    return Response.json([]);
  };

  try {
    const response = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789'
        + '&search=release_candidate&searchScope=content'),
      env,
    );
    const broadResponse = await workerModule.default.fetch(
      new Request('https://worker.example/api/public/reviews?appId=123456789'
        + '&search=release_candidate'),
      env,
    );

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(broadResponse.status, 200, await broadResponse.clone().text());
    const upstreamUrl = new URL(upstreamUrls[0]);
    assert.equal(upstreamUrl.searchParams.get('content'), 'ilike.*release\\_candidate*');
    assert.equal(upstreamUrl.searchParams.has('or'), false);
    assert.match(
      new URL(upstreamUrls[1]).searchParams.get('or'),
      /author\.ilike\.\*release\\_candidate\*/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public reviews reject cursor filter grammar before querying Supabase', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input) => {
    upstreamUrls.push(String(input));
    return Response.json([]);
  };
  const cursor = Buffer.from(JSON.stringify({
    reviewedAt: '2026-07-29T00:00:00.000Z',
    reviewId: 'safe),or(review_id.not.is.null',
  })).toString('base64url');

  try {
    const response = await workerModule.default.fetch(
      new Request(`https://worker.example/api/public/reviews?appId=123456789&cursor=${cursor}`),
      env,
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_request');
    assert.deepEqual(upstreamUrls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
