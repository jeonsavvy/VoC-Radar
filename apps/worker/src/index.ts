import type {
  AlertEventsRequest,
  ClaimJobRequest,
  CreatePipelineJobRequest,
  Env,
  FetchReviewsRequest,
  FilterNewReviewsRequest,
  JobStatusRequest,
  ParseErrorRequest,
  PublishRequest,
  UpsertReviewRequest,
} from './types';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_COUNT = 2;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const ITUNES_REVIEWS_PER_PAGE = 50;
const MAX_FETCH_REVIEW_LIMIT = 500;

type JsonValue = Record<string, unknown> | unknown[];

type RequestInitWithRetry = RequestInit & {
  timeoutMs?: number;
  retries?: number;
  idempotent?: boolean;
};

const encoder = new TextEncoder();

const boolFromEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

function getCorsHeaders(env: Env) {
  return {
    'access-control-allow-origin': env.CORS_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-voc-signature,x-voc-timestamp',
    'access-control-max-age': '86400',
  };
}

function withCors(env: Env, response: Response) {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(env);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function jsonResponse(env: Env, status: number, payload: JsonValue) {
  return withCors(
    env,
    new Response(JSON.stringify(payload), {
      status,
      headers: JSON_HEADERS,
    }),
  );
}

async function fetchWithRetry(
  env: Env,
  url: string,
  init: RequestInitWithRetry,
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const retries = init.retries ?? Number(env.API_RETRY_COUNT || DEFAULT_RETRY_COUNT);
  const timeoutMs = init.timeoutMs ?? Number(env.API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const idempotent = init.idempotent ?? ['GET', 'HEAD', 'OPTIONS'].includes(method);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok && response.status >= 500 && idempotent && attempt < retries) {
        continue;
      }

      return response;
    } catch (error) {
      if (!idempotent || attempt >= retries) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Fetch retry exceeded');
}

async function supabaseRequest<T>(
  env: Env,
  path: string,
  init: RequestInitWithRetry,
): Promise<T> {
  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    return [] as T;
  }

  const text = await response.text();
  if (!text.trim()) {
    return [] as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid json';
    throw new Error(`Supabase response parse failed (${response.status}) on ${path}: ${message}`);
  }
}

async function supabaseUserRequest<T>(
  env: Env,
  path: string,
  userAuthorization: string,
  init: RequestInitWithRetry,
): Promise<T> {
  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: userAuthorization,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase user request failed (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    return [] as T;
  }

  const text = await response.text();
  if (!text.trim()) {
    return [] as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid json';
    throw new Error(`Supabase user response parse failed (${response.status}) on ${path}: ${message}`);
  }
}

async function verifyAccessToken(env: Env, authorization: string | null): Promise<boolean> {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return false;
  }

  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
    idempotent: true,
  });

  return response.ok;
}

function badRequest(env: Env, message: string) {
  return jsonResponse(env, 400, { error: message });
}

function unauthorized(env: Env, message = 'unauthorized') {
  return jsonResponse(env, 401, { error: message });
}

async function signMessage(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return mismatch === 0;
}

async function verifySignedRequest(env: Env, request: Request, rawBody: string): Promise<boolean> {
  const secret = env.PIPELINE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const timestamp = request.headers.get('x-voc-timestamp');
  const signature = request.headers.get('x-voc-signature');
  if (!timestamp || !signature) {
    return false;
  }

  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp)) {
    return false;
  }

  if (Math.abs(Date.now() - parsedTimestamp) > SIGNATURE_WINDOW_MS) {
    return false;
  }

  const expected = await signMessage(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqual(expected, signature);
}

function getPublicCacheKey(request: Request, version: string): Request {
  const url = new URL(request.url);
  url.searchParams.set('__cache_v', version);
  return new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  });
}

async function getEdgeCache() {
  return caches.open('voc-public-cache');
}

async function getCacheVersion(env: Env) {
  try {
    const version = await env.CACHE_STATE?.get('public_cache_version');
    return version || '0';
  } catch {
    return '0';
  }
}

async function setCacheVersion(env: Env, nextVersion: string) {
  if (!env.CACHE_STATE) {
    return;
  }

  await env.CACHE_STATE.put('public_cache_version', nextVersion);
}

function clampLimit(rawValue: string | null, fallback = 25, max = 100) {
  const parsed = Number(rawValue || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function normalizeCountry(rawCountry: string | null | undefined, fallback = 'kr') {
  const normalized = (rawCountry || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!/^[a-z]{2}$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeAppStoreId(rawAppStoreId: string | null | undefined) {
  const normalized = (rawAppStoreId || '').trim();
  if (!normalized || !/^\d{5,20}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeOptionalText(rawValue: unknown, maxLength = 120) {
  const normalized = String(rawValue ?? '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

async function triggerN8nPipeline(
  env: Env,
  payload: {
    jobId: string;
    appStoreId: string;
    country: string;
    requestedAt: string;
  },
): Promise<{ dispatched: boolean; reason?: string; statusCode?: number; detail?: string }> {
  const webhookUrl = (env.N8N_PIPELINE_TRIGGER_URL || '').trim();
  if (!webhookUrl) {
    return {
      dispatched: false,
      reason: 'trigger_webhook_not_configured',
    };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  const triggerSecret = (env.N8N_PIPELINE_TRIGGER_SECRET || '').trim();
  if (triggerSecret) {
    headers['x-voc-trigger-secret'] = triggerSecret;
  }

  const response = await fetchWithRetry(env, webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeoutMs: 10000,
    retries: 2,
    idempotent: true,
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      dispatched: false,
      reason: 'trigger_webhook_failed',
      statusCode: response.status,
      detail: detail.slice(0, 300),
    };
  }

  return {
    dispatched: true,
    statusCode: response.status,
  };
}

function isUuid(value: string | null | undefined) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    (value || '').trim(),
  );
}

function normalizeReviewedAt(rawValue: unknown) {
  const normalized = String(rawValue ?? '').trim();
  if (!normalized) {
    return new Date().toISOString();
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function normalizeRating(rawValue: unknown) {
  const numeric = Number(String(rawValue ?? '').trim() || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(5, Math.round(numeric)));
}

type NormalizedReview = {
  reviewId: string;
  author: string;
  content: string;
  rating: number;
  reviewedAt: string;
};

async function handleInternalFetchReviews(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: FetchReviewsRequest;
  try {
    body = JSON.parse(rawBody) as FetchReviewsRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  if (!appStoreId) {
    return badRequest(env, 'appStoreId must be numeric');
  }

  const country = normalizeCountry(body?.country);
  const requestedLimit = clampLimit(String(body?.limit ?? MAX_FETCH_REVIEW_LIMIT), MAX_FETCH_REVIEW_LIMIT, MAX_FETCH_REVIEW_LIMIT);
  const limit = Math.min(MAX_FETCH_REVIEW_LIMIT, requestedLimit);

  const maxPages = Math.max(1, Math.ceil(limit / ITUNES_REVIEWS_PER_PAGE));
  const reviews: NormalizedReview[] = [];
  const seenIds = new Set<string>();
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages && reviews.length < limit; page += 1) {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/limit=${ITUNES_REVIEWS_PER_PAGE}/id=${appStoreId}/sortBy=mostRecent/json`;
    const response = await fetchWithRetry(env, url, {
      method: 'GET',
      timeoutMs: 30000,
      retries: 2,
      idempotent: true,
    });

    if (!response.ok) {
      const text = await response.text();
      if (page === 1) {
        throw new Error(`iTunes fetch failed (${response.status}): ${text}`);
      }
      break;
    }

    pagesFetched += 1;

    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      if (page === 1) {
        throw new Error('iTunes response parse failed');
      }
      break;
    }

    const feed = payload.feed as Record<string, unknown> | undefined;
    const entries = Array.isArray(feed?.entry) ? (feed.entry as Array<Record<string, unknown>>) : [];
    if (entries.length === 0) {
      break;
    }

    let addedInPage = 0;
    for (const entry of entries) {
      const reviewId = String((entry.id as { label?: string } | undefined)?.label ?? entry.id ?? '').trim();
      const rating = normalizeRating((entry['im:rating'] as { label?: string } | undefined)?.label ?? entry['im:rating']);

      if (!reviewId || rating <= 0 || seenIds.has(reviewId)) {
        continue;
      }
      seenIds.add(reviewId);
      addedInPage += 1;

      reviews.push({
        reviewId,
        author: String(
          ((entry.author as { name?: { label?: string } } | undefined)?.name?.label ??
            (entry.author as { name?: string } | undefined)?.name ??
            'unknown'),
        ).trim(),
        content: String(
          ((entry.content as { label?: string; '#text'?: string } | undefined)?.label ??
            (entry.content as { '#text'?: string } | undefined)?.['#text'] ??
            entry.content ??
            ''),
        ).trim(),
        rating,
        reviewedAt: normalizeReviewedAt((entry.updated as { label?: string } | undefined)?.label ?? entry.updated),
      });

      if (reviews.length >= limit) {
        break;
      }
    }

    if (addedInPage === 0) {
      break;
    }
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      appStoreId,
      country,
      limit,
      pagesFetched,
      reviews,
      totalFetched: reviews.length,
    },
  });
}

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

  const data = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/apps?select=app_store_id,country,app_name,updated_at&order=updated_at.desc&limit=${limit}`,
    {
      method: 'GET',
      idempotent: true,
    },
  );

  return jsonResponse(env, 200, { data });
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

async function handlePrivateCreateJob(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const authorized = await verifyAccessToken(env, authorization);
  if (!authorized) {
    return unauthorized(env, 'invalid access token');
  }

  let body: CreatePipelineJobRequest;
  try {
    body = (await request.json()) as CreatePipelineJobRequest;
  } catch {
    return badRequest(env, 'invalid json body');
  }

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  if (!appStoreId) {
    return badRequest(env, 'appStoreId must be numeric');
  }

  const country = normalizeCountry(body?.country);
  const appName = normalizeOptionalText(body?.appName, 120);
  const note = normalizeOptionalText(body?.note, 300);
  const now = new Date().toISOString();

  await supabaseRequest(env, '/rest/v1/apps?on_conflict=app_store_id,country', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([
      {
        app_store_id: appStoreId,
        country,
        app_name: appName,
        updated_at: now,
      },
    ]),
    idempotent: true,
  });

  let data: Array<Record<string, unknown>> = [];
  try {
    data = await supabaseUserRequest<Array<Record<string, unknown>>>(
      env,
      '/rest/v1/pipeline_jobs',
      authorization,
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          app_store_id: appStoreId,
          country,
          app_name: appName,
          note,
          source: 'web',
          status: 'queued',
          requested_at: now,
          updated_at: now,
        }),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'job create failed';
    if (message.includes('(401)') || message.includes('(403)')) {
      return unauthorized(env, 'insufficient access');
    }
    throw error;
  }

  const created = data[0] || null;
  if (!created) {
    return jsonResponse(env, 500, {
      error:
        'pipeline_jobs insert returned empty response. Check Supabase RLS SELECT policy for authenticated users on pipeline_jobs.',
    });
  }

  const trigger = await triggerN8nPipeline(env, {
    jobId: String(created.id || '').trim(),
    appStoreId,
    country,
    requestedAt: now,
  });

  return jsonResponse(env, 201, {
    ok: true,
    data: created,
    trigger,
  });
}

async function handlePrivateJobs(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const authorized = await verifyAccessToken(env, authorization);
  if (!authorized) {
    return unauthorized(env, 'invalid access token');
  }

  const { searchParams } = new URL(request.url);
  const limit = clampLimit(searchParams.get('limit'), 20, 50);

  let data: Array<Record<string, unknown>> = [];
  try {
    data = await supabaseUserRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_jobs?select=id,app_store_id,country,app_name,source,status,run_id,note,error_message,requested_at,started_at,finished_at,created_at,updated_at&order=created_at.desc&limit=${limit}`,
      authorization,
      {
        method: 'GET',
        idempotent: true,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'job list failed';
    if (message.includes('(401)') || message.includes('(403)')) {
      return unauthorized(env, 'insufficient access');
    }
    throw error;
  }

  return jsonResponse(env, 200, { data });
}

async function handleInternalFilterNewReviews(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: FilterNewReviewsRequest;
  try {
    body = JSON.parse(rawBody) as FilterNewReviewsRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  if (!appStoreId) {
    return badRequest(env, 'appStoreId must be numeric');
  }

  const country = normalizeCountry(body?.country);
  const inputReviews = Array.isArray(body?.reviews) ? body.reviews : [];
  if (inputReviews.length === 0) {
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [] },
    });
  }

  const seen = new Set<string>();
  const normalizedReviews = inputReviews
    .map((review) => ({
      reviewId: String(review.reviewId || '').trim(),
      author: String(review.author || '').trim() || 'unknown',
      content: String(review.content || '').trim(),
      rating: normalizeRating(review.rating),
      reviewedAt: normalizeReviewedAt(review.reviewedAt),
    }))
    .filter((review) => {
      if (!review.reviewId || review.rating <= 0) {
        return false;
      }
      if (seen.has(review.reviewId)) {
        return false;
      }
      seen.add(review.reviewId);
      return true;
    });

  if (normalizedReviews.length === 0) {
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [] },
    });
  }

  const existingRows = await supabaseRequest<Array<{ review_id: string }>>(env, '/rest/v1/rpc/get_existing_review_ids', {
    method: 'POST',
    body: JSON.stringify({
      p_app_store_id: appStoreId,
      p_country: country,
      p_review_ids: normalizedReviews.map((review) => review.reviewId),
    }),
    idempotent: true,
  });

  const existingIds = new Set(existingRows.map((row) => row.review_id));
  const freshReviews = normalizedReviews.filter((review) => !existingIds.has(review.reviewId));

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      total: normalizedReviews.length,
      existingCount: existingIds.size,
      newCount: freshReviews.length,
      reviews: freshReviews,
    },
  });
}

async function handleInternalClaimJob(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: ClaimJobRequest = {};
  try {
    body = rawBody ? (JSON.parse(rawBody) as ClaimJobRequest) : {};
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const allowFallback = body.allowFallback === true;
  const fallbackAppStoreId = allowFallback ? normalizeAppStoreId(body.fallbackAppStoreId) : null;
  const fallbackCountry = allowFallback ? normalizeCountry(body.fallbackCountry) : null;
  const fallbackAppName = allowFallback ? normalizeOptionalText(body.fallbackAppName, 120) : null;

  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/claim_pipeline_job', {
    method: 'POST',
    body: JSON.stringify({
      p_default_app_store_id: fallbackAppStoreId,
      p_default_country: fallbackCountry,
      p_default_app_name: fallbackAppName,
    }),
    idempotent: false,
  });

  const row = rows[0] || {};
  const status = ((row.status as string | null) || 'empty').toLowerCase();
  const jobId = (row.job_id as string | null) || null;
  const isFallback = status === 'fallback';
  const data = {
    jobId,
    noJob: jobId == null && !isFallback,
    appStoreId: (row.app_store_id as string | null) || (isFallback ? fallbackAppStoreId : null),
    country:
      (row.country as string | null) ||
      (isFallback && fallbackCountry ? normalizeCountry(fallbackCountry) : null),
    appName: (row.app_name as string | null) || (isFallback ? fallbackAppName : null),
    source: (row.source as string | null) || 'queue',
    status,
    requestedAt: (row.requested_at as string | null) || new Date().toISOString(),
  };

  return jsonResponse(env, 200, { ok: true, data });
}

async function handleInternalJobStatus(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: JobStatusRequest;
  try {
    body = JSON.parse(rawBody) as JobStatusRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const normalizedJobId = (body?.jobId || '').trim();
  const normalizedStatus = (body?.status || '').trim().toLowerCase();

  if (!isUuid(normalizedJobId)) {
    return badRequest(env, 'jobId must be uuid');
  }

  if (!['queued', 'running', 'completed', 'failed', 'canceled'].includes(normalizedStatus)) {
    return badRequest(env, 'invalid status');
  }

  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/complete_pipeline_job', {
    method: 'POST',
    body: JSON.stringify({
      p_job_id: normalizedJobId,
      p_status: normalizedStatus,
      p_run_id: normalizeOptionalText(body.runId, 120),
      p_error_message: normalizeOptionalText(body.errorMessage, 300),
    }),
    idempotent: true,
  });

  const data = rows[0] || null;
  return jsonResponse(env, 200, { ok: true, data });
}

async function handlePrivateReviews(env: Env, request: Request) {
  if (!boolFromEnv(env.DETAIL_VIEW_ENABLED, true)) {
    return jsonResponse(env, 403, { error: 'detail view disabled' });
  }

  const authorization = request.headers.get('authorization');
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return unauthorized(env, 'missing access token');
  }

  const authorized = await verifyAccessToken(env, authorization);
  if (!authorized) {
    return unauthorized(env, 'invalid access token');
  }

  const { searchParams } = new URL(request.url);
  const appId = searchParams.get('appId');
  const country = searchParams.get('country') || 'kr';
  const limit = clampLimit(searchParams.get('limit'));
  const cursor = searchParams.get('cursor');

  if (!appId) {
    return badRequest(env, 'appId is required');
  }

  const filters = new URLSearchParams({
    app_store_id: `eq.${appId}`,
    country: `eq.${country}`,
    order: 'reviewed_at.desc',
    limit: String(limit),
  });

  if (cursor) {
    filters.set('reviewed_at', `lt.${cursor}`);
  }

  let data: Array<Record<string, unknown>> = [];
  try {
    data = await supabaseUserRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/private_review_feed?${filters.toString()}`,
      authorization,
      {
        method: 'GET',
        idempotent: true,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'private review request failed';
    if (message.includes('(401)') || message.includes('(403)')) {
      return unauthorized(env, 'insufficient access');
    }
    throw error;
  }

  const last = data[data.length - 1] as { reviewed_at?: string } | undefined;
  const nextCursor = data.length >= limit ? (last?.reviewed_at ?? null) : null;

  return jsonResponse(env, 200, { data, nextCursor });
}

async function handleInternalUpsertReviews(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: UpsertReviewRequest;
  try {
    body = JSON.parse(rawBody) as UpsertReviewRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  if (!body?.runId || !body?.app?.appStoreId || !body?.app?.country || !Array.isArray(body.reviews)) {
    return badRequest(env, 'invalid payload');
  }

  const now = new Date().toISOString();

  await supabaseRequest(env, '/rest/v1/apps?on_conflict=app_store_id,country', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([
      {
        app_store_id: body.app.appStoreId,
        country: body.app.country,
        app_name: body.app.appName || null,
        updated_at: now,
      },
    ]),
    idempotent: true,
  });

  const reviewRows = body.reviews.map((review) => ({
    review_id: review.reviewId,
    app_store_id: body.app.appStoreId,
    country: body.app.country,
    rating: review.rating,
    author: review.author || 'unknown',
    content: review.content || '',
    reviewed_at: review.reviewedAt || now,
    raw_source: review.rawSource || null,
    updated_at: now,
  }));

  if (reviewRows.length > 0) {
    await supabaseRequest(env, '/rest/v1/reviews?on_conflict=review_id', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(reviewRows),
      idempotent: true,
    });

    const aiRows = body.reviews.map((review) => ({
      review_id: review.reviewId,
      priority: review.priority || 'Normal',
      category: review.category || '기타',
      summary: review.summary || '분류 결과 없음',
      confidence: review.confidence ?? null,
      model_version: review.modelVersion ?? 'gemini',
      updated_at: now,
    }));

    await supabaseRequest(env, '/rest/v1/review_ai?on_conflict=review_id', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(aiRows),
      idempotent: true,
    });
  }

  await supabaseRequest(env, '/rest/v1/pipeline_runs?on_conflict=run_id', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([
      {
        run_id: body.runId,
        app_store_id: body.app.appStoreId,
        country: body.app.country,
        source: body.source || 'n8n',
        status: 'upserted',
        review_count: reviewRows.length,
        executed_at: now,
        updated_at: now,
      },
    ]),
    idempotent: true,
  });

  if (isUuid(body.jobId || undefined)) {
    await supabaseRequest(env, '/rest/v1/rpc/complete_pipeline_job', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: body.jobId,
        p_status: 'running',
        p_run_id: body.runId,
      }),
      idempotent: true,
    });
  }

  return jsonResponse(env, 200, {
    ok: true,
    runId: body.runId,
    upsertedReviews: reviewRows.length,
  });
}

async function handleInternalParseError(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: ParseErrorRequest;
  try {
    body = JSON.parse(rawBody) as ParseErrorRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  if (!body?.parseErrorId || !body?.message) {
    return badRequest(env, 'invalid payload');
  }

  const now = new Date().toISOString();

  await supabaseRequest(env, '/rest/v1/parse_errors?on_conflict=parse_error_id', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([
      {
        parse_error_id: body.parseErrorId,
        run_id: body.runId || null,
        app_store_id: body.appStoreId || null,
        country: body.country || null,
        message: body.message,
        raw_response: body.rawResponse?.slice(0, 8000) || '',
        created_at: now,
      },
    ]),
    idempotent: true,
  });

  if (isUuid(body.jobId || undefined)) {
    await supabaseRequest(env, '/rest/v1/rpc/complete_pipeline_job', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: body.jobId,
        p_status: 'failed',
        p_run_id: normalizeOptionalText(body.runId, 120),
        p_error_message: normalizeOptionalText(body.message, 300),
      }),
      idempotent: true,
    });
  }

  return jsonResponse(env, 200, {
    ok: true,
    parseErrorId: body.parseErrorId,
  });
}

async function handleInternalPublish(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: PublishRequest;
  try {
    body = JSON.parse(rawBody) as PublishRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  if (!body?.runId || !body?.appStoreId || !body?.country) {
    return badRequest(env, 'invalid payload');
  }

  const publishedAt = body.publishedAt || new Date().toISOString();

  await setCacheVersion(env, String(Date.now()));

  await supabaseRequest(env, '/rest/v1/pipeline_runs?run_id=eq.' + encodeURIComponent(body.runId), {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'published',
      published_at: publishedAt,
      updated_at: new Date().toISOString(),
    }),
    idempotent: true,
  });

  if (isUuid(body.jobId || undefined)) {
    await supabaseRequest(env, '/rest/v1/rpc/complete_pipeline_job', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: body.jobId,
        p_status: 'completed',
        p_run_id: body.runId,
      }),
      idempotent: true,
    });
  }

  return jsonResponse(env, 200, {
    ok: true,
    runId: body.runId,
    publishedAt,
  });
}

async function handleInternalAlertEvents(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) {
    return unauthorized(env, 'invalid signature');
  }

  let body: AlertEventsRequest;
  try {
    body = JSON.parse(rawBody) as AlertEventsRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  if (!body?.runId || !body?.appStoreId || !body?.country || !Array.isArray(body.alerts)) {
    return badRequest(env, 'invalid payload');
  }

  const normalizedCountry = normalizeCountry(body.country);

  const rows = body.alerts.map((alert) => ({
    event_id: `${body.appStoreId}_${normalizedCountry}_${alert.reviewId}`,
    run_id: body.runId,
    review_id: alert.reviewId,
    app_store_id: body.appStoreId,
    country: normalizedCountry,
    rating: alert.rating,
    priority: alert.priority,
    category: alert.category,
    summary: alert.summary,
    sent_at: alert.sentAt || new Date().toISOString(),
  }));

  if (rows.length === 0) {
    return jsonResponse(env, 200, { ok: true, inserted: 0 });
  }

  await supabaseRequest(env, '/rest/v1/alert_events?on_conflict=event_id', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
    idempotent: true,
  });

  return jsonResponse(env, 200, { ok: true, inserted: rows.length });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return withCors(env, new Response(null, { status: 204 }));
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      return jsonResponse(env, 500, {
        error: 'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY are required',
      });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return jsonResponse(env, 200, {
          ok: true,
          detailViewEnabled: boolFromEnv(env.DETAIL_VIEW_ENABLED, true),
          timestamp: new Date().toISOString(),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/public/overview') {
        return await handlePublicOverview(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/trends') {
        return await handlePublicTrends(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/categories') {
        return await handlePublicCategories(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/apps') {
        return await handlePublicApps(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/app-meta') {
        return await handlePublicAppMeta(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/private/jobs') {
        return await handlePrivateJobs(env, request);
      }

      if (request.method === 'POST' && url.pathname === '/api/private/jobs') {
        return await handlePrivateCreateJob(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/private/reviews') {
        return await handlePrivateReviews(env, request);
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/claim-job') {
        return await handleInternalClaimJob(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/fetch-reviews') {
        return await handleInternalFetchReviews(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/job-status') {
        return await handleInternalJobStatus(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/filter-new-reviews') {
        return await handleInternalFilterNewReviews(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/upsert-reviews') {
        return await handleInternalUpsertReviews(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/parse-error') {
        return await handleInternalParseError(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/publish') {
        return await handleInternalPublish(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/alert-events') {
        return await handleInternalAlertEvents(env, request, await request.text());
      }

      return jsonResponse(env, 404, { error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return jsonResponse(env, 500, {
        error: message,
      });
    }
  },
};
