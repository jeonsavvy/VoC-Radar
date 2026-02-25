import type {
  AlertEventsRequest,
  Env,
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

  return (await response.json()) as T;
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

  return (await response.json()) as T;
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

  const body = JSON.parse(rawBody) as UpsertReviewRequest;

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

  const body = JSON.parse(rawBody) as ParseErrorRequest;
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

  const body = JSON.parse(rawBody) as PublishRequest;
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

  const body = JSON.parse(rawBody) as AlertEventsRequest;
  if (!body?.runId || !body?.appStoreId || !body?.country || !Array.isArray(body.alerts)) {
    return badRequest(env, 'invalid payload');
  }

  const rows = body.alerts.map((alert) => ({
    event_id: `${body.runId}_${alert.reviewId}`,
    run_id: body.runId,
    review_id: alert.reviewId,
    app_store_id: body.appStoreId,
    country: body.country,
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

      if (request.method === 'GET' && url.pathname === '/api/private/reviews') {
        return await handlePrivateReviews(env, request);
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
