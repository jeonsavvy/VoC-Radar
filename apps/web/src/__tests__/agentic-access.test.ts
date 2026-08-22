import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(relativePath: string) {
  return readFileSync(relativePath, 'utf8');
}

function visibleText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('raw homepage explains VoC Radar without JavaScript', () => {
  const html = read('index.html');
  const text = visibleText(html);

  assert.match(html, /<h1(?:\s[^>]*)?>VoC Radar<\/h1>/);
  assert.ok(text.length >= 500, `expected at least 500 visible characters, received ${text.length}`);
  assert.match(text, /App Store 공개 리뷰/);
  assert.match(html, /href="\/llms\.txt"/);
  assert.match(html, /href="\/openapi\.json"/);
});

test('homepage publishes complete identity metadata without inventing organization data', () => {
  const html = read('index.html');
  assert.match(html, /property="og:type" content="website"/);
  assert.match(html, /property="og:image" content="https:\/\/voc-radar\.satinode\.com\/apple-touch-icon\.png"/);

  const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(jsonLd, 'expected JSON-LD metadata');
  const structuredData = JSON.parse(jsonLd);
  assert.equal(structuredData['@type'], 'SoftwareApplication');
  assert.equal(structuredData.url, 'https://voc-radar.satinode.com/');
  assert.equal('address' in structuredData, false);
  assert.equal('contactPoint' in structuredData, false);
});

test('agent discovery files name the canonical public resources and boundaries', () => {
  const robots = read('public/robots.txt');
  const llms = read('public/llms.txt');
  const sitemap = read('public/sitemap.xml');

  assert.match(robots, /^Sitemap: https:\/\/voc-radar\.satinode\.com\/sitemap\.xml$/m);
  assert.match(llms, /^# VoC Radar$/m);
  assert.match(llms, /## When to use VoC Radar/);
  assert.match(llms, /https:\/\/voc-radar\.satinode\.com\/openapi\.json/);
  assert.match(llms, /\/api\/private\/\*/);
  assert.match(llms, /\/api\/internal\/\*/);
  assert.match(sitemap, /<loc>https:\/\/voc-radar\.satinode\.com\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/voc-radar\.satinode\.com\/privacy<\/loc>/);
});

test('OpenAPI stays in parity with the public GET router', () => {
  const publicSource = read('../worker/src/public.ts');
  const workerSource = read('../worker/src/index.ts');
  const specification = JSON.parse(read('public/openapi.json'));
  const literalPublicPaths = [...publicSource.matchAll(/url\.pathname === '([^']+)'/g)]
    .map((match) => match[1]);
  const expectedPaths = new Set([
    ...literalPublicPaths,
    '/api/public/issues/{issueId}',
    ...(workerSource.includes("url.pathname === '/api/health'") ? ['/api/health'] : []),
  ]);
  const documentedPaths = new Set(Object.keys(specification.paths));

  assert.deepEqual([...documentedPaths].sort(), [...expectedPaths].sort());
  assert.equal([...documentedPaths].some((path) => path.includes('/private/') || path.includes('/internal/')), false);

  const operationIds = new Set<string>();
  for (const [path, pathItem] of Object.entries<any>(specification.paths)) {
    const operation = pathItem.get;
    assert.ok(operation, `${path} must document GET`);
    assert.equal(typeof operation.operationId, 'string', `${path} must have operationId`);
    assert.ok(operation.description?.length > 0, `${path} must have a description`);
    assert.equal(operationIds.has(operation.operationId), false, `${operation.operationId} must be unique`);
    operationIds.add(operation.operationId);
    assert.ok(operation.responses?.['200']?.content, `${path} must describe its success body`);
    if (path.startsWith('/api/public/')) {
      assert.equal(
        operation.responses?.['502']?.$ref,
        '#/components/responses/UpstreamUnavailable',
        `${path} must document its upstream failure envelope`,
      );
    }
  }
});
