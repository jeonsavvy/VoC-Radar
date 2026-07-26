import type { Env } from './types';
import {
  withCors,
  jsonResponse,
  errorResponse,
  cacheableJsonResponse,
  fetchWithRetry,
  supabaseRequest,
  badRequest,
  getPublicCacheKey,
  getEdgeCache,
  getCacheVersion,
  clampLimit,
  parsePage,
  parsePrivateReviewSortBy,
  parseSortDirection,
  parseRatingFilter,
  normalizePriorityFilter,
  normalizeSearchKeyword,
  normalizeCountry,
  normalizeAppStoreId,
  normalizeOptionalText,
  normalizeVocCategory,
  normalizeIssueLabel,
  normalizeActionHint,
  derivePriorityValue,
  isUuid,
  decodeReviewFeedCursor,
  isLegacyTimestampCursor,
  buildReviewFeedFilters,
  normalizeReviewFeedRows,
  JSON_HEADERS,
  boolFromEnv,
} from './platform';

async function handlePublicOverview(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = searchParams.get('appId');
  const country = searchParams.get('country') || 'kr';
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const response = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_overview', {
    method: 'POST',
    body: JSON.stringify({
      p_app_store_id: appId,
      p_country: country,
      p_from: from,
      p_to: to,
    }),
    idempotent: true,
  });

  const data = response[0] || {
    app_store_id: appId,
    country,
    total_reviews: 0,
    critical_count: 0,
    low_rating_count: 0,
    average_rating: 0,
    positive_ratio: 0,
    last_review_at: null,
  };

  const finalResponse = withCors(
    env,
    new Response(JSON.stringify({ data }), {
      headers: {
        ...JSON_HEADERS,
        'cache-control': 'public, max-age=120, s-maxage=120',
      },
    }),
  );

  await cache.put(cacheKey, finalResponse.clone());
  return finalResponse;
}

async function handlePublicTrends(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = searchParams.get('appId');
  const country = searchParams.get('country') || 'kr';
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const data = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_trends', {
    method: 'POST',
    body: JSON.stringify({
      p_app_store_id: appId,
      p_country: country,
      p_from: from,
      p_to: to,
    }),
    idempotent: true,
  });

  const finalResponse = withCors(
    env,
    new Response(JSON.stringify({ data }), {
      headers: {
        ...JSON_HEADERS,
        'cache-control': 'public, max-age=120, s-maxage=120',
      },
    }),
  );

  await cache.put(cacheKey, finalResponse.clone());
  return finalResponse;
}

async function handlePublicCategories(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = searchParams.get('appId');
  const country = searchParams.get('country') || 'kr';
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const data = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    '/rest/v1/rpc/get_public_categories',
    {
      method: 'POST',
      body: JSON.stringify({
        p_app_store_id: appId,
        p_country: country,
        p_from: from,
        p_to: to,
      }),
      idempotent: true,
    },
  );

  const finalResponse = withCors(
    env,
    new Response(JSON.stringify({ data }), {
      headers: {
        ...JSON_HEADERS,
        'cache-control': 'public, max-age=120, s-maxage=120',
      },
    }),
  );

  await cache.put(cacheKey, finalResponse.clone());
  return finalResponse;
}

async function handlePublicApps(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLimit(searchParams.get('limit'), 20, 100);
  const runLimit = Math.min(Math.max(limit * 10, limit), 200);
  const recentRuns = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_runs?select=app_store_id,country,executed_at,published_at,updated_at,review_count,status&status=eq.published&review_count=gt.0&order=published_at.desc.nullslast&limit=${runLimit}`,
    {
      method: 'GET',
      idempotent: true,
    },
  );

  const recentApps: Array<{ app_store_id: string; country: string; updated_at: string }> = [];
  const seen = new Set<string>();

  for (const row of recentRuns) {
    const appStoreId = normalizeAppStoreId(String(row.app_store_id ?? ''));
    const country = normalizeCountry(String(row.country ?? ''));
    if (!appStoreId) {
      continue;
    }

    const key = `${appStoreId}:${country}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    recentApps.push({
      app_store_id: appStoreId,
      country,
      updated_at: String(row.published_at || row.executed_at || row.updated_at || new Date().toISOString()),
    });

    if (recentApps.length >= limit) {
      break;
    }
  }

  const appsMeta = await Promise.all(
    recentApps.map(async (item) => {
      const rows = await supabaseRequest<Array<Record<string, unknown>>>(
        env,
        `/rest/v1/apps?select=app_name&app_store_id=eq.${encodeURIComponent(item.app_store_id)}&country=eq.${encodeURIComponent(item.country)}&limit=1`,
        {
          method: 'GET',
          idempotent: true,
        },
      );

      return {
        ...item,
        app_name: String(rows[0]?.app_name || '').trim() || null,
      };
    }),
  );

  const data = appsMeta.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return jsonResponse(env, 200, { data });
}

async function handlePublicAppsSearch(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const query = normalizeSearchKeyword(searchParams.get('q'), 60);
  const limit = clampLimit(searchParams.get('limit'), 8, 20);

  if (!query) {
    return jsonResponse(env, 200, { data: [] });
  }

  const candidateLimit = Math.min(limit * 5, 100);
  const candidates = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/apps?select=app_store_id,country,app_name,updated_at&or=(app_name.ilike.*${encodeURIComponent(query)}*,app_store_id.ilike.*${encodeURIComponent(query)}*)&order=updated_at.desc.nullslast&limit=${candidateLimit}`,
    {
      method: 'GET',
      idempotent: true,
    },
  );

  if (candidates.length === 0) return jsonResponse(env, 200, { data: [] });

  const appIds = [...new Set(
    candidates
      .map((row) => normalizeAppStoreId(String(row.app_store_id || '')))
      .filter((id): id is string => Boolean(id)),
  )];
  const countries = [...new Set(candidates.map((row) => normalizeCountry(String(row.country || ''))))];
  const publishedRuns = appIds.length === 0
    ? []
    : await supabaseRequest<Array<Record<string, unknown>>>(
        env,
        `/rest/v1/pipeline_runs?select=app_store_id,country&status=eq.published&app_store_id=in.(${appIds.map(encodeURIComponent).join(',')})&country=in.(${countries.map(encodeURIComponent).join(',')})&limit=1000`,
        { method: 'GET', idempotent: true },
      );
  const publishedKeys = new Set(
    publishedRuns.map((row) => `${normalizeAppStoreId(String(row.app_store_id || ''))}:${normalizeCountry(String(row.country || ''))}`),
  );
  const data = candidates
    .filter((row) => publishedKeys.has(
      `${normalizeAppStoreId(String(row.app_store_id || ''))}:${normalizeCountry(String(row.country || ''))}`,
    ))
    .slice(0, limit);

  return jsonResponse(env, 200, { data });
}

type AppleCatalogItem = {
  trackId?: number | string;
  trackName?: string;
  artworkUrl100?: string;
  bundleId?: string;
  sellerName?: string;
};

function decodeHtmlMetadata(value: string) {
  return value.replace(/&(amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'nbsp') return ' ';
    const radix = normalized.startsWith('#x') ? 16 : 10;
    const codePoint = Number.parseInt(normalized.replace(/^#x?/, ''), radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function extractOpenGraphContent(html: string, property: 'og:image' | 'og:title') {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propertyFirst = new RegExp(
    `<meta[^>]+property=["']${escapedProperty}["'][^>]+content=["']([^"']+)`,
    'i',
  );
  const contentFirst = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapedProperty}["']`,
    'i',
  );
  const value = propertyFirst.exec(html)?.[1] || contentFirst.exec(html)?.[1] || '';
  return decodeHtmlMetadata(value.trim());
}

function normalizeAppStoreArtworkUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.hostname !== 'mzstatic.com' && !url.hostname.endsWith('.mzstatic.com'))) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/[^/]+$/, '/100x100bb.jpg');
    url.search = '';
    url.hash = '';
    return normalizeOptionalText(url.toString(), 500);
  } catch {
    return null;
  }
}

async function fetchAppStorePageMetadata(
  env: Env,
  appId: string,
  country: string,
  options: { timeoutMs?: number; retries?: number } = {},
) {
  const response = await fetchWithRetry(env, `https://apps.apple.com/${country}/app/id${encodeURIComponent(appId)}`, {
    upstream: 'apple',
    method: 'GET',
    headers: {
      accept: 'text/html',
      range: 'bytes=0-16383',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
    },
    timeoutMs: options.timeoutMs ?? 5000,
    retries: options.retries ?? 0,
    idempotent: true,
  });
  if (!response.ok) return null;

  const html = (await response.text()).slice(0, 65536);
  const artworkUrl100 = normalizeAppStoreArtworkUrl(extractOpenGraphContent(html, 'og:image'));
  const title = extractOpenGraphContent(html, 'og:title');
  const trackName = normalizeOptionalText(title.replace(/\s+(?:앱\s*)?-\s*App Store.*$/i, ''), 120);
  return artworkUrl100 || trackName ? { artworkUrl100, trackName } : null;
}

async function requestAppleCatalog(
  env: Env,
  url: string,
  options: { timeoutMs?: number; retries?: number } = {},
) {
  const response = await fetchWithRetry(env, url, {
    upstream: 'apple',
    method: 'GET',
    timeoutMs: options.timeoutMs ?? 15000,
    retries: options.retries ?? 2,
    idempotent: true,
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { results?: AppleCatalogItem[] };
  return Array.isArray(payload.results) ? payload.results : [];
}

async function fetchAppleCatalogByIds(
  env: Env,
  appIds: string[],
  country: string,
  options: { timeoutMs?: number; retries?: number } = {},
) {
  const normalizedIds = [
    ...new Set(
      appIds
        .map((appId) => normalizeAppStoreId(appId))
        .filter((appId): appId is string => Boolean(appId)),
    ),
  ];
  if (normalizedIds.length === 0) return [];

  const ids = normalizedIds.map(encodeURIComponent).join(',');
  let catalog: AppleCatalogItem[] = [];
  try {
    catalog = await requestAppleCatalog(
      env,
      `https://itunes.apple.com/lookup?id=${ids}&country=${country.toUpperCase()}`,
      options,
    );
  } catch {
    // App Store HTML below remains available when an edge network cannot reach the legacy lookup API.
  }

  const catalogById = new Map<string, AppleCatalogItem>();
  for (const app of catalog) {
    const appId = normalizeAppStoreId(String(app.trackId || ''));
    if (appId) catalogById.set(appId, app);
  }
  const missingArtworkIds = normalizedIds.filter((appId) => !catalogById.get(appId)?.artworkUrl100);
  const pageMetadata = await Promise.all(
    missingArtworkIds.map(async (appId) => ({
      appId,
      metadata: await fetchAppStorePageMetadata(env, appId, country, options).catch(() => null),
    })),
  );
  for (const { appId, metadata } of pageMetadata) {
    if (!metadata) continue;
    const existing = catalogById.get(appId);
    if (existing) {
      existing.artworkUrl100 ||= metadata.artworkUrl100 || undefined;
      existing.trackName ||= metadata.trackName || undefined;
      continue;
    }
    const fallback: AppleCatalogItem = {
      trackId: appId,
      artworkUrl100: metadata.artworkUrl100 || undefined,
      trackName: metadata.trackName || undefined,
    };
    catalog.push(fallback);
    catalogById.set(appId, fallback);
  }
  return catalog;
}

function extractAppStoreId(value: string) {
  const trimmed = value.trim();
  const direct = normalizeAppStoreId(trimmed);
  if (direct) return direct;
  const match = trimmed.match(/(?:\/id|\bid)(\d{5,20})(?:\b|[/?#])/i);
  return normalizeAppStoreId(match?.[1]);
}

async function fetchAppleCatalog(env: Env, query: string, country: string, limit: number) {
  const appId = extractAppStoreId(query);
  if (appId) return fetchAppleCatalogByIds(env, [appId], country);

  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=${country.toUpperCase()}&entity=software&limit=${limit}`;
  return requestAppleCatalog(env, url);
}

async function handlePublicDiscover(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const query = normalizeSearchKeyword(searchParams.get('q'), 180);
  const country = normalizeCountry(searchParams.get('country'));
  const limit = clampLimit(searchParams.get('limit'), 8, 12);

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const respond = async (data: Array<Record<string, unknown>>) => {
    const response = cacheableJsonResponse(env, { data });
    await cache.put(cacheKey, response.clone());
    return response;
  };

  if (!query) {
    const runs = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_runs?select=app_store_id,country,published_at,updated_at&status=eq.published&order=published_at.desc.nullslast&limit=${limit * 4}`,
      { method: 'GET', idempotent: true },
    );
    const seen = new Set<string>();
    const recentRuns: Array<{
      appStoreId: string;
      country: string;
      lastAnalyzedAt: unknown;
    }> = [];
    for (const run of runs) {
      const id = normalizeAppStoreId(String(run.app_store_id || ''));
      const appCountry = normalizeCountry(String(run.country || country));
      if (!id || seen.has(`${id}:${appCountry}`)) continue;
      seen.add(`${id}:${appCountry}`);
      recentRuns.push({
        appStoreId: id,
        country: appCountry,
        lastAnalyzedAt: run.published_at || run.updated_at || null,
      });
      if (recentRuns.length >= limit) break;
    }

    const appIds = [...new Set(recentRuns.map((run) => run.appStoreId))];
    const countries = [...new Set(recentRuns.map((run) => run.country))];
    const idsByCountry = new Map<string, string[]>();
    for (const run of recentRuns) {
      idsByCountry.set(run.country, [...(idsByCountry.get(run.country) || []), run.appStoreId]);
    }
    const [apps, catalogGroups] = await Promise.all([
      appIds.length
        ? supabaseRequest<Array<Record<string, unknown>>>(
            env,
            `/rest/v1/apps?select=app_store_id,country,app_name&app_store_id=in.(${appIds.map(encodeURIComponent).join(',')})&country=in.(${countries.map(encodeURIComponent).join(',')})`,
            { method: 'GET', idempotent: true },
          )
        : [],
      Promise.all(
        [...idsByCountry].map(async ([appCountry, ids]) => ({
          country: appCountry,
          items: await fetchAppleCatalogByIds(env, ids, appCountry, { timeoutMs: 2500, retries: 0 }).catch(
            () => [],
          ),
        })),
      ),
    ]);
    const appNames = new Map(
      apps.map((app) => [
        `${normalizeAppStoreId(String(app.app_store_id || ''))}:${normalizeCountry(String(app.country || country))}`,
        normalizeOptionalText(app.app_name, 120),
      ]),
    );
    const catalogApps = new Map<string, AppleCatalogItem>();
    for (const group of catalogGroups) {
      for (const app of group.items) {
        const id = normalizeAppStoreId(String(app.trackId || ''));
        if (id) catalogApps.set(`${id}:${group.country}`, app);
      }
    }
    const recent = recentRuns.map((run) => {
      const key = `${run.appStoreId}:${run.country}`;
      const catalogApp = catalogApps.get(key);
      return {
        appStoreId: run.appStoreId,
        country: run.country,
        appName: appNames.get(key) || normalizeOptionalText(catalogApp?.trackName, 120),
        artworkUrl: normalizeOptionalText(catalogApp?.artworkUrl100, 500),
        bundleId: normalizeOptionalText(catalogApp?.bundleId, 180),
        developerName: normalizeOptionalText(catalogApp?.sellerName, 180),
        analyzed: true,
        lastAnalyzedAt: run.lastAnalyzedAt,
        source: 'catalog',
      };
    });
    return respond(recent);
  }

  const appId = extractAppStoreId(query);
  const dbFilter = appId
    ? `app_store_id=eq.${encodeURIComponent(appId)}`
    : `or=(app_name.ilike.*${encodeURIComponent(query)}*,app_store_id.ilike.*${encodeURIComponent(query)}*)`;

  const [knownApps, appleItems, publishedRuns] = await Promise.all([
    supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/apps?select=app_store_id,country,app_name,updated_at&${dbFilter}&order=updated_at.desc.nullslast&limit=${limit}`,
      { method: 'GET', idempotent: true },
    ),
    fetchAppleCatalog(env, query, country, limit),
    supabaseRequest<Array<Record<string, unknown>>>(
      env,
      '/rest/v1/pipeline_runs?select=app_store_id,country,published_at,updated_at&status=eq.published&order=published_at.desc.nullslast&limit=200',
      { method: 'GET', idempotent: true },
    ),
  ]);

  const analyzed = new Map<string, string>();
  for (const run of publishedRuns) {
    const key = `${String(run.app_store_id || '')}:${normalizeCountry(String(run.country || ''))}`;
    if (!analyzed.has(key)) analyzed.set(key, String(run.published_at || run.updated_at || ''));
  }

  const merged = new Map<string, Record<string, unknown>>();
  for (const app of knownApps) {
    const id = normalizeAppStoreId(String(app.app_store_id || ''));
    const appCountry = normalizeCountry(String(app.country || country));
    if (!id) continue;
    const key = `${id}:${appCountry}`;
    merged.set(key, {
      appStoreId: id,
      country: appCountry,
      appName: normalizeOptionalText(app.app_name, 120),
      artworkUrl: null,
      bundleId: null,
      developerName: null,
      analyzed: analyzed.has(key),
      lastAnalyzedAt: analyzed.get(key) || null,
      source: 'catalog',
    });
  }

  for (const app of appleItems) {
    const id = normalizeAppStoreId(String(app.trackId || ''));
    if (!id) continue;
    const key = `${id}:${country}`;
    const previous = merged.get(key) || {};
    merged.set(key, {
      ...previous,
      appStoreId: id,
      country,
      appName: normalizeOptionalText(app.trackName, 120),
      artworkUrl: normalizeOptionalText(app.artworkUrl100, 500),
      bundleId: normalizeOptionalText(app.bundleId, 180),
      developerName: normalizeOptionalText(app.sellerName, 180),
      analyzed: analyzed.has(key),
      lastAnalyzedAt: analyzed.get(key) || null,
      source: analyzed.has(key) ? 'catalog' : 'app_store',
    });
  }

  const data = [...merged.values()]
    .sort((a, b) => Number(Boolean(b.analyzed)) - Number(Boolean(a.analyzed)))
    .slice(0, limit);
  return respond(data);
}

function mapIssueCluster(row: Record<string, unknown>) {
  return {
    issueId: String(row.issue_id || ''),
    title: String(row.title || ''),
    category: String(row.category || ''),
    severity: String(row.severity || 'low'),
    reviewCount: Number(row.review_count || 0),
    changePercent: row.change_percent == null ? null : Number(row.change_percent),
    evidenceCount: Number(row.evidence_count || 0),
    lastOccurredAt: row.last_occurred_at || null,
    summary: String(row.summary || ''),
    actionHint: normalizeOptionalText(row.action_hint, 300),
    runId: String(row.run_id || ''),
    modelVersion: String(row.model_version || ''),
    analyzedAt: row.analyzed_at || null,
  };
}

async function getPublicIssueClusters(env: Env, appId: string, country: string, limit = 50) {
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_issue_clusters', {
    method: 'POST',
    body: JSON.stringify({ p_app_store_id: appId, p_country: country, p_limit: limit }),
    idempotent: true,
  });
  return rows.map(mapIssueCluster);
}

async function handlePublicReport(env: Env, request: Request) {
  if (!boolFromEnv(env.REPORT_V2_ENABLED, false)) {
    return errorResponse(env, 404, 'report_v2_disabled', '이 리포트 기능은 현재 사용할 수 없습니다.');
  }
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (!appId) return badRequest(env, 'appId is required');

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const [overviewRows, categories, trends, issues, runs, apps, catalog] = await Promise.all([
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_overview', {
      method: 'POST',
      body: JSON.stringify({ p_app_store_id: appId, p_country: country, p_from: from, p_to: to }),
      idempotent: true,
    }),
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_categories', {
      method: 'POST',
      body: JSON.stringify({ p_app_store_id: appId, p_country: country, p_from: from, p_to: to }),
      idempotent: true,
    }),
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_trends', {
      method: 'POST',
      body: JSON.stringify({ p_app_store_id: appId, p_country: country, p_from: from, p_to: to }),
      idempotent: true,
    }),
    getPublicIssueClusters(env, appId, country),
    supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_runs?select=run_id,status,model_version,published_at,updated_at&app_store_id=eq.${encodeURIComponent(appId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&order=published_at.desc&limit=1`,
      { method: 'GET', idempotent: true },
    ),
    supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/apps?select=app_name&app_store_id=eq.${encodeURIComponent(appId)}&country=eq.${encodeURIComponent(country)}&limit=1`,
      { method: 'GET', idempotent: true },
    ),
    fetchAppleCatalogByIds(env, [appId], country, { timeoutMs: 2500, retries: 0 }).catch(() => []),
  ]);

  const overview = overviewRows[0] || {};
  const run = runs[0] || null;
  const catalogApp = catalog.find((app) => normalizeAppStoreId(String(app.trackId || '')) === appId) || null;
  const appName = normalizeOptionalText(apps[0]?.app_name, 120) || normalizeOptionalText(catalogApp?.trackName, 120);
  const lastAnalyzedAt = run?.published_at || run?.updated_at || null;
  const totalReviews = Number(overview.total_reviews || 0);
  const lowRatingCount = Number(overview.low_rating_count || 0);
  const data = {
    app: {
      appStoreId: appId,
      country,
      appName,
      artworkUrl: normalizeOptionalText(catalogApp?.artworkUrl100, 500),
    },
    summary: {
      totalReviews,
      issueCount: issues.length,
      averageRating: Number(overview.average_rating || 0),
      lowRatingCount,
      lowRatingRatio: totalReviews > 0 ? Number(((lowRatingCount / totalReviews) * 100).toFixed(1)) : 0,
      positiveRatio: Number(overview.positive_ratio || 0),
      lastReviewAt: overview.last_review_at || null,
    },
    analysis: {
      status: run?.status === 'published' ? 'analyzed' : 'not_analyzed',
      runId: run?.run_id || null,
      modelVersion: run?.model_version || issues[0]?.modelVersion || null,
      lastAnalyzedAt,
      stale: lastAnalyzedAt ? Date.now() - new Date(String(lastAnalyzedAt)).getTime() > 24 * 60 * 60 * 1000 : false,
    },
    issues,
    categories: categories.map((row) => ({
      category: String(row.category || ''),
      totalReviews: Number(row.total_reviews || 0),
      sharePercent: Number(row.share_percent || 0),
    })),
    trends: trends.map((row) => ({
      date: row.bucket_date,
      totalReviews: Number(row.total_reviews || 0),
      averageRating: Number(row.average_rating || 0),
    })),
  };
  const response = cacheableJsonResponse(env, { data });
  await cache.put(cacheKey, response.clone());
  return response;
}

async function handlePublicIssueDetail(env: Env, request: Request, issueId: string) {
  if (!boolFromEnv(env.REPORT_V2_ENABLED, false)) {
    return errorResponse(env, 404, 'report_v2_disabled', '이 리포트 기능은 현재 사용할 수 없습니다.');
  }
  if (!isUuid(issueId)) return badRequest(env, 'issue id must be uuid');
  const data = await supabaseRequest<Record<string, unknown> | null>(env, '/rest/v1/rpc/get_public_issue_detail', {
    method: 'POST',
    body: JSON.stringify({ p_issue_id: issueId }),
    idempotent: true,
  });
  if (!data) return errorResponse(env, 404, 'issue_not_found', '요청한 이슈를 찾을 수 없습니다.');
  return jsonResponse(env, 200, { data });
}

async function getPublicRunsForApp(env: Env, appId: string, country: string, limit = 5) {
  return supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_runs?select=run_id,app_store_id,country,source,status,review_count,model_version,validation_status,executed_at,published_at,updated_at&app_store_id=eq.${encodeURIComponent(appId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&order=published_at.desc.nullslast&limit=${limit}`,
    {
      method: 'GET',
      idempotent: true,
    },
  );
}

async function handlePublicRuns(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const limit = clampLimit(searchParams.get('limit'), 5, 20);

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const data = await getPublicRunsForApp(env, appId, country, limit);
  return jsonResponse(env, 200, { data });
}

async function getPublicIssuesForApp(
  env: Env,
  params: {
    appId: string;
    country: string;
    from: string | null;
    to: string | null;
    limit: number;
  },
) {
  return supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_issues', {
    method: 'POST',
    body: JSON.stringify({
      p_app_store_id: params.appId,
      p_country: params.country,
      p_from: params.from,
      p_to: params.to,
      p_limit: params.limit,
    }),
    idempotent: true,
  });
}

async function handlePublicIssues(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const limit = clampLimit(searchParams.get('limit'), 10, 50);

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  if (boolFromEnv(env.REPORT_V2_ENABLED, false)) {
    const data = await getPublicIssueClusters(env, appId, country, limit);
    return jsonResponse(env, 200, { data });
  }

  const data = await getPublicIssuesForApp(env, { appId, country, from, to, limit });
  return jsonResponse(env, 200, { data });
}

async function getPublicEvidenceForApp(
  env: Env,
  params: {
    appId: string;
    country: string;
    from: string | null;
    to: string | null;
    limit: number;
  },
) {
  const filters = new URLSearchParams({
    app_store_id: `eq.${params.appId}`,
    country: `eq.${params.country}`,
    select:
      'review_id,reviewed_at,rating,author,priority,category,issue_label,summary,action_hint,content',
    order: 'reviewed_at.desc',
    limit: String(params.limit),
  });

  if (params.from) {
    filters.set('reviewed_at', `gte.${params.from}`);
  }
  if (params.to) {
    filters.append('reviewed_at', `lte.${params.to}`);
  }

  return supabaseRequest<Array<Record<string, unknown>>>(env, `/rest/v1/private_review_feed?${filters.toString()}`, {
    method: 'GET',
    idempotent: true,
  });
}

async function handlePublicDashboard(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const [overviewRows, categories, trends, issues, runs, evidence, appMetaRows] = await Promise.all([
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_overview', {
      method: 'POST',
      body: JSON.stringify({
        p_app_store_id: appId,
        p_country: country,
        p_from: from,
        p_to: to,
      }),
      idempotent: true,
    }),
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_categories', {
      method: 'POST',
      body: JSON.stringify({
        p_app_store_id: appId,
        p_country: country,
        p_from: from,
        p_to: to,
      }),
      idempotent: true,
    }),
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/get_public_trends', {
      method: 'POST',
      body: JSON.stringify({
        p_app_store_id: appId,
        p_country: country,
        p_from: from,
        p_to: to,
      }),
      idempotent: true,
    }),
    getPublicIssuesForApp(env, { appId, country, from, to, limit: 12 }),
    getPublicRunsForApp(env, appId, country, 5),
    getPublicEvidenceForApp(env, { appId, country, from, to, limit: 6 }),
    supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/apps?select=app_store_id,country,app_name&app_store_id=eq.${encodeURIComponent(appId)}&country=eq.${encodeURIComponent(country)}&limit=1`,
      {
        method: 'GET',
        idempotent: true,
      },
    ),
  ]);

  const overview = overviewRows[0] || {
    app_store_id: appId,
    country,
    total_reviews: 0,
    critical_count: 0,
    low_rating_count: 0,
    average_rating: 0,
    positive_ratio: 0,
    last_review_at: null,
  };
  const latestRun = runs[0] || null;
  const lowRatingCount = Number(overview.low_rating_count || 0);
  const totalReviews = Number(overview.total_reviews || 0);
  const summary = {
    app_store_id: appId,
    country,
    app_name: String(appMetaRows[0]?.app_name || '').trim() || null,
    total_reviews: totalReviews,
    issue_count: issues.length,
    critical_count: Number(overview.critical_count || 0),
    low_rating_count: lowRatingCount,
    low_rating_ratio: totalReviews > 0 ? Number(((lowRatingCount / totalReviews) * 100).toFixed(1)) : 0,
    average_rating: Number(overview.average_rating || 0),
    positive_ratio: Number(overview.positive_ratio || 0),
    last_review_at: overview.last_review_at || null,
    last_published_at: latestRun?.published_at || null,
    latest_run_status: (latestRun?.status as string | undefined) || 'idle',
  };

  const data = {
    summary,
    categories,
    trends,
    issues: issues.map((row) => ({
      ...row,
      category: normalizeVocCategory(row.category, row.reason_summary, ''),
    })),
    evidence: evidence.map((row) => ({
      ...row,
      category: normalizeVocCategory(row.category, row.summary, row.content),
      issue_label: normalizeIssueLabel(row.issue_label, normalizeVocCategory(row.category, row.summary, row.content), row.summary),
      action_hint: normalizeActionHint(row.action_hint, normalizeVocCategory(row.category, row.summary, row.content)),
      priority: derivePriorityValue(Number(row.rating || 0), normalizeVocCategory(row.category, row.summary, row.content), row.priority),
    })),
    runs,
  };

  const finalResponse = withCors(
    env,
    new Response(JSON.stringify({ data }), {
      headers: {
        ...JSON_HEADERS,
        'cache-control': 'public, max-age=120, s-maxage=120',
      },
    }),
  );

  await cache.put(cacheKey, finalResponse.clone());
  return finalResponse;
}

async function handlePublicAppMeta(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const version = await getCacheVersion(env);
  const cacheKey = getPublicCacheKey(request, version);
  const cache = await getEdgeCache();
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCors(env, cached);
  }

  const apps = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/apps?select=app_store_id,country,app_name&app_store_id=eq.${encodeURIComponent(appId)}&country=eq.${encodeURIComponent(country)}&limit=1`,
    {
      method: 'GET',
      idempotent: true,
    },
  );

  const appNameFromDb = String(apps[0]?.app_name || '').trim();
  if (appNameFromDb) {
    const response = withCors(
      env,
      new Response(
        JSON.stringify({
          data: {
            app_store_id: appId,
            country,
            app_name: appNameFromDb,
            source: 'supabase',
          },
        }),
        {
          headers: {
            ...JSON_HEADERS,
            'cache-control': 'public, max-age=1800, s-maxage=1800',
          },
        },
      ),
    );
    await cache.put(cacheKey, response.clone());
    return response;
  }

  let appNameFromItunes: string | null = null;
  const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${country.toUpperCase()}`;
  const lookupResponse = await fetchWithRetry(env, lookupUrl, {
    upstream: 'apple',
    method: 'GET',
    timeoutMs: 15000,
    retries: 2,
    idempotent: true,
  });

  if (lookupResponse.ok) {
    const payload = (await lookupResponse.json()) as {
      results?: Array<{ trackName?: string }>;
    };
    const rawName = payload.results?.[0]?.trackName;
    if (typeof rawName === 'string' && rawName.trim()) {
      appNameFromItunes = rawName.trim();
    }
  }

  if (appNameFromItunes) {
    await supabaseRequest(env, '/rest/v1/apps?on_conflict=app_store_id,country', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([
        {
          app_store_id: appId,
          country,
          app_name: appNameFromItunes,
          updated_at: new Date().toISOString(),
        },
      ]),
      idempotent: true,
    });
  }

  const response = withCors(
    env,
    new Response(
      JSON.stringify({
        data: {
          app_store_id: appId,
          country,
          app_name: appNameFromItunes,
          source: appNameFromItunes ? 'itunes' : 'unknown',
        },
      }),
      {
        headers: {
          ...JSON_HEADERS,
          'cache-control': 'public, max-age=1800, s-maxage=1800',
        },
      },
    ),
  );

  await cache.put(cacheKey, response.clone());
  return response;
}



async function handlePublicReviews(env: Env, request: Request) {
  if (!boolFromEnv(env.DETAIL_VIEW_ENABLED, true)) return errorResponse(env, 403, 'detail_view_disabled', '리뷰 상세 조회 기능은 현재 사용할 수 없습니다.');
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const limit = clampLimit(searchParams.get('limit'));
  const page = parsePage(searchParams.get('page'));
  const sortBy = parsePrivateReviewSortBy(searchParams.get('sortBy'));
  const sortDirection = parseSortDirection(searchParams.get('sortDirection'));
  const rating = parseRatingFilter(searchParams.get('rating'));
  const priority = normalizePriorityFilter(searchParams.get('priority'));
  const category = normalizeOptionalText(searchParams.get('category'), 120);
  const issueLabel = normalizeOptionalText(searchParams.get('issueLabel'), 120);
  const search = normalizeSearchKeyword(searchParams.get('search'));
  const cursor = searchParams.get('cursor');
  if (!appId) return badRequest(env, 'appId must be numeric');
  if (cursor && isLegacyTimestampCursor(cursor)) return errorResponse(env, 400, 'legacy_cursor_unsupported', '이전 형식의 리뷰 커서는 안전하게 이어갈 수 없습니다. cursor를 제거하고 첫 페이지부터 다시 조회해 주세요.');
  if (cursor && (sortBy !== 'reviewed_at' || !decodeReviewFeedCursor(cursor))) return badRequest(env, 'cursor is invalid for the selected sort');
  const filters = buildReviewFeedFilters({ appId, country, limit, page, sortBy, sortDirection, rating, priority, category, issueLabel, search, cursor });
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, `/rest/v1/private_review_feed?${filters.toString()}`, { method: 'GET', idempotent: true });
  const normalized = normalizeReviewFeedRows(rows, limit, sortBy);
  return jsonResponse(env, 200, { data: normalized.data, page, limit, hasNext: normalized.hasNext, nextCursor: normalized.nextCursor });
}

/** Returns null when the request is not a public API route. */
export async function routePublicRequest(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/public/discover') return handlePublicDiscover(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/report') return handlePublicReport(env, request);
  const issueDetailMatch = url.pathname.match(/^\/api\/public\/issues\/([0-9a-f-]+)$/i);
  if (request.method === 'GET' && issueDetailMatch) return handlePublicIssueDetail(env, request, issueDetailMatch[1] || '');
  if (request.method === 'GET' && url.pathname === '/api/public/overview') return handlePublicOverview(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/trends') return handlePublicTrends(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/categories') return handlePublicCategories(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/dashboard') return handlePublicDashboard(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/issues') return handlePublicIssues(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/reviews') return handlePublicReviews(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/apps') return handlePublicApps(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/apps/search') return handlePublicAppsSearch(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/app-meta') return handlePublicAppMeta(env, request);
  if (request.method === 'GET' && url.pathname === '/api/public/runs') return handlePublicRuns(env, request);
  return null;
}
