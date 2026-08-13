import type { Env } from './types';

// index.ts는 VoC-Radar의 단일 API 진입점이다.
// 공개 조회, 로그인 사용자 작업 제어, n8n 내부 파이프라인 호출을 한 파일에서 나눈다.

// -----------------------------------------------------------------------------
// 공통 응답 / 외부 호출 기본값
// -----------------------------------------------------------------------------
export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_RETRY_COUNT = 2;
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_FETCH_WINDOW_DAYS = 30;
export const MAX_FETCH_WINDOW_DAYS = 90;
export const DEFAULT_FETCH_MAX_PAGES = 40;
export const MAX_FETCH_MAX_PAGES = 40;
export const MAX_FETCH_REVIEW_CAP = 10000;
export const ITUNES_USER_REVIEW_PAGE_SIZE = 10;
export const PIPELINE_DB_TIMEOUT_MS = 10_000;
export const PUBLIC_API_CACHE_CONTROL = 'public, max-age=120, s-maxage=120';

export type JsonValue = Record<string, unknown> | unknown[];

export class UpstreamRequestError extends Error {
  constructor(
    readonly upstream: 'database' | 'auth' | 'apple' | 'pipeline_trigger',
    readonly status: number,
    readonly upstreamCode?: string,
  ) {
    super('Upstream request failed');
    this.name = 'UpstreamRequestError';
  }
}
export type RequestInitWithRetry = RequestInit & {
  timeoutMs?: number;
  retries?: number;
  idempotent?: boolean;
  upstream?: UpstreamRequestError['upstream'];
};

export const encoder = new TextEncoder();

function boundedIntegerFromEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  if (parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export const boolFromEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

// 모든 응답은 같은 CORS 정책을 사용한다.
export function getCorsHeaders(env: Env) {
  return {
    'access-control-allow-origin': env.CORS_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-voc-signature,x-voc-timestamp,x-voc-token,x-idempotency-key',
    'access-control-max-age': '86400',
  };
}

export function withCors(env: Env, response: Response) {
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

export function jsonResponse(env: Env, status: number, payload: JsonValue) {
  return withCors(
    env,
    new Response(JSON.stringify(payload), {
      status,
      headers: JSON_HEADERS,
    }),
  );
}

export function errorResponse(
  env: Env,
  status: number,
  error: string,
  message: string,
  retryable = false,
  requestId = crypto.randomUUID(),
) {
  return jsonResponse(env, status, {
    ok: false,
    error,
    message,
    requestId,
    retryable,
  });
}

export function cacheableJsonResponse(env: Env, payload: JsonValue) {
  return withCors(
    env,
    new Response(JSON.stringify(payload), {
      headers: {
        ...JSON_HEADERS,
        'cache-control': PUBLIC_API_CACHE_CONTROL,
      },
    }),
  );
}

// fetchWithRetry는 Worker가 외부 시스템과 통신할 때 지키는 기본 규칙이다.
// - timeout을 강제한다.
// - GET 계열만 재시도한다.
// - 재시도 여부는 idempotent 플래그로 제어한다.
export async function fetchWithRetry(
  env: Env,
  url: string,
  init: RequestInitWithRetry,
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const retries = init.retries ?? boundedIntegerFromEnv(
    env.API_RETRY_COUNT,
    DEFAULT_RETRY_COUNT,
    0,
  );
  const timeoutMs = init.timeoutMs ?? boundedIntegerFromEnv(
    env.API_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1,
    2_147_483_647,
  );
  const idempotent = init.idempotent ?? ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const { timeoutMs: _timeoutMs, retries: _retries, idempotent: _idempotent, upstream, ...requestInit } = init;
  const upstreamKind = upstream || 'database';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

    try {
      const response = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
      });

      if (!response.ok && response.status >= 500 && idempotent && attempt < retries) {
        continue;
      }

      return response;
    } catch (error) {
      if (!idempotent || attempt >= retries) {
        throw new UpstreamRequestError(upstreamKind, controller.signal.aborted ? 504 : 503);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new UpstreamRequestError(upstreamKind, 503);
}

// -----------------------------------------------------------------------------
// Supabase 호출 래퍼
// -----------------------------------------------------------------------------

// 서비스 권한(service_role)으로 Supabase를 호출한다.
export async function supabaseRequest<T>(
  env: Env,
  path: string,
  init: RequestInitWithRetry,
): Promise<T> {
  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}${path}`, {
    ...init,
    upstream: 'database',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    let upstreamCode: string | undefined;
    try {
      const payload = (await response.json()) as { code?: unknown };
      const candidate = typeof payload.code === 'string' ? payload.code.trim() : '';
      if (/^[a-z0-9_]{1,40}$/i.test(candidate)) upstreamCode = candidate;
    } catch {
      // Never retain or log upstream response bodies.
    }
    throw new UpstreamRequestError('database', response.status, upstreamCode);
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
  } catch {
    throw new UpstreamRequestError('database', 502, 'invalid_response');
  }
}

// 사용자 토큰 기반으로 Supabase를 호출한다.
// RLS가 걸린 비공개 테이블은 이 경로로만 접근한다.
export async function supabaseUserRequest<T>(
  env: Env,
  path: string,
  userAuthorization: string,
  init: RequestInitWithRetry,
): Promise<T> {
  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}${path}`, {
    ...init,
    upstream: 'database',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: userAuthorization,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    let upstreamCode: string | undefined;
    try {
      const payload = (await response.json()) as { code?: unknown };
      const candidate = typeof payload.code === 'string' ? payload.code.trim() : '';
      if (/^[a-z0-9_]{1,40}$/i.test(candidate)) upstreamCode = candidate;
    } catch {
      // Never retain or log upstream response bodies.
    }
    throw new UpstreamRequestError('database', response.status, upstreamCode);
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
  } catch {
    throw new UpstreamRequestError('database', 502, 'invalid_response');
  }
}

export async function runSupabaseKeepalive(env: Env): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
    return;
  }

  await Promise.all([
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/apps?select=app_store_id&limit=1', {
      method: 'GET',
      idempotent: true,
    }),
    supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/pipeline_runs?select=run_id&limit=1', {
      method: 'GET',
      idempotent: true,
    }),
  ]);
}

export async function deleteSupabaseAuthUser(env: Env, userId: string): Promise<void> {
  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    upstream: 'auth',
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    idempotent: false,
  });

  if (!response.ok) {
    throw new UpstreamRequestError('auth', response.status);
  }
}

// -----------------------------------------------------------------------------
// 인증 / 서명 검증
// -----------------------------------------------------------------------------

// Bearer 토큰에서 사용자 ID를 확인한다.
export async function getAuthUser(env: Env, authorization: string | null): Promise<{ id: string } | null> {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null;
  }

  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}/auth/v1/user`, {
    upstream: 'auth',
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
    idempotent: true,
  });

  if (!response.ok) {
    if ([401, 403].includes(response.status)) return null;
    throw new UpstreamRequestError('auth', response.status);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new UpstreamRequestError('auth', 502, 'invalid_response');
  }

  try {
    const parsed = JSON.parse(text) as { id?: string };
    const userId = (parsed.id || '').trim();
    if (!isUuid(userId)) {
      throw new UpstreamRequestError('auth', 502, 'invalid_response');
    }
    return { id: userId };
  } catch (error) {
    if (error instanceof UpstreamRequestError) throw error;
    throw new UpstreamRequestError('auth', 502, 'invalid_response');
  }
}

export async function verifyAccessToken(env: Env, authorization: string | null): Promise<boolean> {
  const user = await getAuthUser(env, authorization);
  return Boolean(user);
}

export function badRequest(env: Env, message: string) {
  return errorResponse(env, 400, 'invalid_request', message);
}

export function unauthorized(env: Env, message = 'unauthorized') {
  return errorResponse(env, 401, 'unauthorized', message);
}

// 내부 API는 x-voc-token 또는 HMAC 서명으로만 허용한다.
export async function signMessage(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(aHash, bHash);
  }

  // Node's Web Crypto test runtime does not implement the Workers extension.
  // Production Workers always take the crypto.subtle.timingSafeEqual branch.
  const left = new Uint8Array(aHash);
  const right = new Uint8Array(bHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index]! ^ right[index]!;
  }
  return mismatch === 0;
}

export async function verifySignedRequest(env: Env, request: Request, rawBody: string): Promise<boolean> {
  const secret = env.PIPELINE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const token = request.headers.get('x-voc-token')?.trim();
  if (token) {
    return timingSafeEqual(token, secret);
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

export function getPublicCacheKey(request: Request, version: string): Request {
  const url = new URL(request.url);
  url.searchParams.set('__cache_v', version);
  return new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  });
}

export async function getEdgeCache() {
  return caches.open('voc-public-cache');
}

export async function getCacheVersion(env: Env) {
  try {
    const version = await env.CACHE_STATE?.get('public_cache_version');
    return version || '0';
  } catch {
    return '0';
  }
}

export async function setCacheVersion(env: Env, nextVersion: string) {
  if (!env.CACHE_STATE) {
    return;
  }

  await env.CACHE_STATE.put('public_cache_version', nextVersion);
}

export function clampLimit(rawValue: string | null, fallback = 25, max = 100) {
  const parsed = Number(rawValue || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export function parsePage(rawValue: string | null, fallback = 1, max = 1000) {
  const parsed = Number(rawValue || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export type PrivateReviewSortBy = 'reviewed_at' | 'author' | 'rating' | 'priority' | 'category' | 'issue_label' | 'summary';
export type SortDirection = 'asc' | 'desc';
export type NormalizedPriority = 'Critical' | 'High' | 'Normal';
export type NormalizedCategory = '버그 및 성능' | '계정 및 결제' | '콘텐츠 및 운영 정책' | '기능 및 사용성' | '긍정 리뷰 및 기타';

// -----------------------------------------------------------------------------
// 입력 정규화 / 표시용 파생 값
// -----------------------------------------------------------------------------

export const ALLOWED_CATEGORIES: NormalizedCategory[] = [
  '버그 및 성능',
  '계정 및 결제',
  '콘텐츠 및 운영 정책',
  '기능 및 사용성',
  '긍정 리뷰 및 기타',
];

export function parsePrivateReviewSortBy(rawValue: string | null): PrivateReviewSortBy {
  const normalized = (rawValue || '').trim().toLowerCase();
  if (
    normalized === 'reviewed_at' ||
    normalized === 'author' ||
    normalized === 'rating' ||
    normalized === 'priority' ||
    normalized === 'category' ||
    normalized === 'issue_label' ||
    normalized === 'summary'
  ) {
    return normalized;
  }
  return 'reviewed_at';
}

export function parseSortDirection(rawValue: string | null, fallback: SortDirection = 'desc'): SortDirection {
  const normalized = (rawValue || '').trim().toLowerCase();
  if (normalized === 'asc' || normalized === 'desc') {
    return normalized;
  }
  return fallback;
}

export function parseRatingFilter(rawValue: string | null) {
  if (!rawValue) {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) {
    return null;
  }
  return Math.floor(parsed);
}

export function normalizePriorityFilter(rawValue: string | null) {
  const normalized = (rawValue || '').trim();
  if (!normalized) {
    return null;
  }
  if (normalized === 'Critical' || normalized === 'High' || normalized === 'Normal') {
    return normalized;
  }
  return null;
}

export function normalizeSearchKeyword(rawValue: string | null, maxLength = 80) {
  const normalized = (rawValue || '').trim();
  if (!normalized) {
    return null;
  }
  return normalized
    .slice(0, maxLength)
    .replace(/[%*(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTimestampFilter(rawValue: string | null) {
  const normalized = (rawValue || '').trim();
  if (!normalized) return null;
  const timestamp = new Date(normalized);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

export function normalizeCountry(rawCountry: string | null | undefined, fallback = 'kr') {
  const normalized = (rawCountry || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!/^[a-z]{2}$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

export function normalizeAppStoreId(rawAppStoreId: string | null | undefined) {
  const normalized = (rawAppStoreId || '').trim();
  if (!normalized || !/^\d{5,20}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizeOptionalText(rawValue: unknown, maxLength = 120) {
  const normalized = String(rawValue ?? '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

export function normalizeVocCategory(rawCategory: unknown, rawSummary?: unknown, rawContent?: unknown): NormalizedCategory {
  const source = `${String(rawCategory ?? '')} ${String(rawSummary ?? '')} ${String(rawContent ?? '')}`.trim().toLowerCase();

  if (!source) {
    return '긍정 리뷰 및 기타';
  }

  if (
    /(버그|오류|에러|튕|크래시|멈춤|먹통|작동.?안|실행.?안|느림|지연|렉|버벅|속도|발열|배터리|프리징|로딩|lag|slow|performance|stability|bug|error|crash|fail)/.test(
      source,
    )
  ) {
    return '버그 및 성능';
  }

  if (
    /(결제|구독|환불|인앱|구매|billing|payment|subscription|refund|로그인|log in|login|계정|인증|회원가입|가입|account|auth|sign in|sign-in|signin)/.test(
      source,
    )
  ) {
    return '계정 및 결제';
  }

  if (
    /(콘텐츠|커뮤니티|운영|정책|약관|규정|신고|정지|제재|차단|검수|게시글|피드|노출|알림|고객센터|문의|응대|content|community|policy|moderation|report|ban|suspend|support)/.test(
      source,
    )
  ) {
    return '콘텐츠 및 운영 정책';
  }

  if (
    /(사용성|불편|ui|ux|디자인|가독성|동선|메뉴|접근성|편의|요청|기능.?추가|추가해|개선해|지원해|원해|feature request|please add|wish)/.test(
      source,
    )
  ) {
    return '기능 및 사용성';
  }

  return '긍정 리뷰 및 기타';
}

export function normalizePriorityValue(rawPriority: unknown): NormalizedPriority {
  const normalized = String(rawPriority ?? '')
    .replace(/[🚨⚠️✅]/g, '')
    .trim()
    .toLowerCase();

  if (normalized.includes('critical')) {
    return 'Critical';
  }
  if (normalized.includes('high')) {
    return 'High';
  }
  return 'Normal';
}

export function normalizeIssueLabel(rawIssueLabel: unknown, category: NormalizedCategory, summary?: unknown) {
  const normalized = String(rawIssueLabel ?? '').trim();
  if (normalized) {
    return normalized.slice(0, 60);
  }

  const summaryText = String(summary ?? '').trim();
  if (summaryText) {
    return summaryText.slice(0, 60);
  }

  switch (category) {
    case '버그 및 성능':
      return '성능/안정성 점검';
    case '계정 및 결제':
      return '계정/결제 불편';
    case '콘텐츠 및 운영 정책':
      return '운영 정책 확인';
    case '기능 및 사용성':
      return '사용성 개선';
    default:
      return '긍정/기타 확인';
  }
}

export function normalizeReasonSummary(rawReasonSummary: unknown, summary?: unknown) {
  const normalized = String(rawReasonSummary ?? '').trim();
  if (normalized) {
    return normalized.slice(0, 200);
  }

  const fallback = String(summary ?? '').trim();
  return fallback ? fallback.slice(0, 200) : '원인 요약 없음';
}

export function defaultActionHint(category: NormalizedCategory) {
  switch (category) {
    case '버그 및 성능':
      return '오류 재현 후 안정화 우선순위를 확인하세요.';
    case '계정 및 결제':
      return '로그인·결제 흐름과 고객 문의 로그를 함께 점검하세요.';
    case '콘텐츠 및 운영 정책':
      return '운영 정책/고객 응대 문구를 함께 검토하세요.';
    case '기능 및 사용성':
      return '불편 구간을 정의하고 개선 우선순위를 정리하세요.';
    default:
      return '긍정/일반 의견은 다음 개선 후보로 정리하세요.';
  }
}

export function normalizeActionHint(rawActionHint: unknown, category: NormalizedCategory) {
  const normalized = String(rawActionHint ?? '').trim();
  if (normalized) {
    return normalized.slice(0, 200);
  }
  return defaultActionHint(category);
}

export function derivePriorityValue(rating: number, category: NormalizedCategory, rawPriority: unknown): NormalizedPriority {
  const normalized = normalizePriorityValue(rawPriority);
  if (normalized !== 'Normal') {
    return normalized;
  }

  if (rating <= 1 && (category === '버그 및 성능' || category === '계정 및 결제')) {
    return 'Critical';
  }

  if (rating <= 2 && category !== '긍정 리뷰 및 기타') {
    return 'High';
  }

  return normalized;
}

export async function triggerN8nPipeline(
  env: Env,
  payload: {
    jobId: string;
    appStoreId: string;
    country: string;
    requestedAt: string;
  },
): Promise<{ dispatched: boolean; reason?: string }> {
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
  if (!triggerSecret) {
    return {
      dispatched: false,
      reason: 'trigger_webhook_secret_not_configured',
    };
  }
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  headers['x-voc-timestamp'] = timestamp;
  headers['x-voc-signature'] = await signMessage(triggerSecret, `${timestamp}.${body}`);

  let response: Response;
  try {
    response = await fetchWithRetry(env, webhookUrl, {
      method: 'POST',
      headers,
      body,
      timeoutMs: 10000,
      retries: 2,
      // webhook은 중복 호출 시 부작용이 생길 수 있어 재시도 대상에서 제외한다.
      idempotent: false,
      upstream: 'pipeline_trigger',
    });
  } catch {
    return { dispatched: false, reason: 'trigger_webhook_failed' };
  }

  if (!response.ok) {
    return {
      dispatched: false,
      reason: 'trigger_webhook_failed',
    };
  }

  return {
    dispatched: true,
  };
}

export function isUuid(value: string | null | undefined) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    (value || '').trim(),
  );
}

export type PipelineStage = 'queued' | 'fetching' | 'extracting' | 'clustering' | 'publishing';

export type PipelineClaim = {
  jobId: string;
  claimToken: string;
  runId: string;
};

export function normalizePipelineClaim(input: Partial<PipelineClaim>): PipelineClaim | null {
  const jobId = String(input.jobId || '').trim();
  const claimToken = String(input.claimToken || '').trim();
  const runId = normalizeOptionalText(input.runId, 160);
  if (!isUuid(jobId) || !isUuid(claimToken) || !runId) return null;
  return { jobId, claimToken, runId };
}

export function jobClaimLost(env: Env) {
  return errorResponse(
    env,
    409,
    'job_claim_lost',
    '이 작업의 실행 권한이 만료되었거나 취소되었습니다. 현재 작업을 중지하고 새 요청을 사용해 주세요.',
  );
}

export async function renewPipelineJobClaim(
  env: Env,
  claim: PipelineClaim,
  stage: PipelineStage | null = null,
): Promise<Record<string, unknown> | null> {
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/renew_pipeline_job_claim', {
    method: 'POST',
    body: JSON.stringify({
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
      p_run_id: claim.runId,
      p_stage: stage,
    }),
    idempotent: true,
    timeoutMs: PIPELINE_DB_TIMEOUT_MS,
    retries: 0,
  });
  return rows[0] || null;
}

// All state transitions are fenced by the claim token in one database RPC.
export async function completePipelineJob(
  env: Env,
  input: PipelineClaim & {
    status: 'running' | 'completed' | 'failed' | 'canceled';
    stage?: PipelineStage | null;
    errorMessage?: string | null;
  },
): Promise<{ updated: boolean; data: Record<string, unknown> | null }> {
  const claim = normalizePipelineClaim(input);
  if (!claim) return { updated: false, data: null };

  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/complete_pipeline_job', {
    method: 'POST',
    body: JSON.stringify({
      p_job_id: claim.jobId,
      p_claim_token: claim.claimToken,
      p_status: input.status,
      p_stage: input.stage ?? null,
      p_run_id: claim.runId,
      p_error_message:
        input.status === 'failed'
          ? normalizeOptionalText(input.errorMessage, 300) || 'The analysis failed. Retry the request.'
          : null,
    }),
    idempotent: true,
    timeoutMs: PIPELINE_DB_TIMEOUT_MS,
    retries: 0,
  });
  return { updated: rows.length > 0, data: rows[0] || null };
}

export function normalizeReviewedAt(rawValue: unknown) {
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

export function normalizeRating(rawValue: unknown) {
  const numeric = Number(String(rawValue ?? '').trim() || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(5, Math.round(numeric)));
}

export type NormalizedReview = {
  reviewId: string;
  author: string;
  content: string;
  rating: number;
  reviewedAt: string;
};

export type ReviewFeedCursor = { reviewedAt: string; reviewId: string };

export function encodeReviewFeedCursor(row: Record<string, unknown>): string | null {
  const reviewedAt = String(row.reviewed_at || '').trim();
  const reviewId = String(row.review_id || '').trim();
  if (
    !Number.isFinite(new Date(reviewedAt).getTime())
    || !/^[A-Za-z0-9_-]{1,256}$/.test(reviewId)
  ) return null;
  const bytes = encoder.encode(JSON.stringify({ reviewedAt, reviewId }));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeReviewFeedCursor(value: string | null): ReviewFeedCursor | null {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(normalized)) return null;
  try {
    const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(base64);
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    const parsed = JSON.parse(decoded) as Partial<ReviewFeedCursor>;
    const reviewedAt = String(parsed.reviewedAt || '').trim();
    const reviewId = String(parsed.reviewId || '').trim();
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(reviewId)
      || !Number.isFinite(new Date(reviewedAt).getTime())
    ) return null;
    return { reviewedAt: new Date(reviewedAt).toISOString(), reviewId };
  } catch {
    return null;
  }
}

export function isLegacyTimestampCursor(value: string | null) {
  const normalized = String(value || '').trim();
  return normalized.length > 0 && Number.isFinite(new Date(normalized).getTime());
}

function escapeReviewSearchPattern(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/_/g, '\\_');
}

export function buildReviewFeedFilters(input: {
  appId: string;
  country: string;
  limit: number;
  page: number;
  sortBy: PrivateReviewSortBy;
  sortDirection: SortDirection;
  rating: number | null;
  priority: string | null;
  category: string | null;
  issueLabel: string | null;
  search: string | null;
  searchScope?: 'all' | 'content';
  from?: string | null;
  to?: string | null;
  cursor: string | null;
}) {
  const queryLimit = Math.min(input.limit + 1, 101);
  const offset = Math.max(0, (input.page - 1) * input.limit);
  const order = input.sortBy === 'reviewed_at'
    ? 'reviewed_at.' + input.sortDirection + ',review_id.' + input.sortDirection
    : input.sortBy + '.' + input.sortDirection + ',reviewed_at.desc,review_id.desc';

  const filters = new URLSearchParams({
    app_store_id: 'eq.' + input.appId,
    country: 'eq.' + input.country,
    order,
    limit: String(queryLimit),
  });

  const decodedCursor = input.sortBy === 'reviewed_at' ? decodeReviewFeedCursor(input.cursor) : null;
  const cursorOperator = input.sortDirection === 'asc' ? 'gt' : 'lt';
  const cursorExpression = decodedCursor
    ? 'or(reviewed_at.' + cursorOperator + '.' + decodedCursor.reviewedAt
      + ',and(reviewed_at.eq.' + decodedCursor.reviewedAt
      + ',review_id.' + cursorOperator + '.' + decodedCursor.reviewId + '))'
    : null;

  if (!cursorExpression) filters.set('offset', String(offset));
  if (input.rating != null) filters.set('rating', 'eq.' + input.rating);
  if (input.priority) filters.set('priority', 'eq.' + input.priority);
  if (input.category) filters.set('category', 'eq.' + input.category);
  if (input.issueLabel) filters.set('issue_label', 'eq.' + input.issueLabel);
  if (input.from) filters.append('reviewed_at', 'gte.' + input.from);
  if (input.to) filters.append('reviewed_at', 'lte.' + input.to);

  if (input.search) {
    const contentOnly = input.searchScope === 'content';
    const searchValue = escapeReviewSearchPattern(input.search);
    const pattern = '*' + searchValue + '*';
    const searchExpression = contentOnly
      ? 'content.ilike.' + pattern
      : 'or(author.ilike.' + pattern
        + ',summary.ilike.' + pattern
        + ',category.ilike.' + pattern
        + ',issue_label.ilike.' + pattern
        + ',reason_summary.ilike.' + pattern
        + ',action_hint.ilike.' + pattern
        + ',content.ilike.' + pattern + ')';
    if (cursorExpression) filters.set('and', '(' + cursorExpression + ',' + searchExpression + ')');
    else if (contentOnly) filters.set('content', 'ilike.' + pattern);
    else filters.set('or', '(' + searchExpression.slice(3, -1) + ')');
  } else if (cursorExpression) {
    filters.set('or', '(' + cursorExpression.slice(3, -1) + ')');
  }

  return filters;
}

// 리뷰 피드는 검색/정렬/커서 조건을 Worker에서 한 번 더 정규화한다.
export function normalizeReviewFeedRows(rows: Array<Record<string, unknown>>, limit: number, sortBy: PrivateReviewSortBy) {
  const hasNext = rows.length > limit;
  const slicedRows = hasNext ? rows.slice(0, limit) : rows;
  const normalizedRows = slicedRows.map((row) => {
    const summary = String(row.summary ?? '');
    const content = String(row.content ?? '');
    const normalizedCategory = normalizeVocCategory(row.category, summary, content);
    const issue_label = normalizeIssueLabel(row.issue_label, normalizedCategory, summary);
    return {
      ...row,
      category: normalizedCategory,
      issue_label,
      reason_summary: normalizeReasonSummary(row.reason_summary, summary),
      action_hint: normalizeActionHint(row.action_hint, normalizedCategory),
      priority: derivePriorityValue(Number(row.rating || 0), normalizedCategory, row.priority),
    };
  });
  const last = normalizedRows[normalizedRows.length - 1];
  return {
    data: normalizedRows,
    hasNext,
    nextCursor: hasNext && last && sortBy === 'reviewed_at' ? encodeReviewFeedCursor(last) : null,
  };
}
