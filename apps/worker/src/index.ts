import type {
  AlertEventsRequest,
  CancelPipelineJobsRequest,
  ClaimJobRequest,
  ClusterContextRequest,
  CreatePipelineJobRequest,
  Env,
  FetchReviewsRequest,
  FilterNewReviewsRequest,
  JobStatusRequest,
  ParseErrorRequest,
  PublishRequest,
  UpsertClustersRequest,
  UpsertReviewRequest,
} from './types';
import { validateClusterContract } from './cluster-contract';

// index.ts는 VoC-Radar의 단일 API 진입점이다.
// 공개 조회, 로그인 사용자 작업 제어, n8n 내부 파이프라인 호출을 한 파일에서 나눈다.

// -----------------------------------------------------------------------------
// 공통 응답 / 외부 호출 기본값
// -----------------------------------------------------------------------------
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRY_COUNT = 2;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_WINDOW_DAYS = 30;
const MAX_FETCH_WINDOW_DAYS = 90;
const DEFAULT_FETCH_MAX_PAGES = 120;
const MAX_FETCH_MAX_PAGES = 200;
const MAX_FETCH_REVIEW_CAP = 10000;
const ITUNES_USER_REVIEW_PAGE_SIZE = 10;

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

// 모든 응답은 같은 CORS 정책을 사용한다.
function getCorsHeaders(env: Env) {
  return {
    'access-control-allow-origin': env.CORS_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-voc-signature,x-voc-timestamp,x-voc-token,x-idempotency-key',
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

// fetchWithRetry는 Worker가 외부 시스템과 통신할 때 지키는 기본 규칙이다.
// - timeout을 강제한다.
// - GET 계열만 재시도한다.
// - 재시도 여부는 idempotent 플래그로 제어한다.
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

// -----------------------------------------------------------------------------
// Supabase 호출 래퍼
// -----------------------------------------------------------------------------

// 서비스 권한(service_role)으로 Supabase를 호출한다.
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

// 사용자 토큰 기반으로 Supabase를 호출한다.
// RLS가 걸린 비공개 테이블은 이 경로로만 접근한다.
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

async function runSupabaseKeepalive(env: Env): Promise<void> {
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

async function deleteSupabaseAuthUser(env: Env, userId: string): Promise<void> {
  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    idempotent: false,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase auth delete failed (${response.status}): ${text || response.statusText}`);
  }
}

// -----------------------------------------------------------------------------
// 인증 / 서명 검증
// -----------------------------------------------------------------------------

// Bearer 토큰에서 사용자 ID를 확인한다.
async function getAuthUser(env: Env, authorization: string | null): Promise<{ id: string } | null> {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null;
  }

  const response = await fetchWithRetry(env, `${env.SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
    idempotent: true,
  });

  if (!response.ok) {
    return null;
  }

  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as { id?: string };
    const userId = (parsed.id || '').trim();
    if (!isUuid(userId)) {
      return null;
    }
    return { id: userId };
  } catch {
    return null;
  }
}

async function verifyAccessToken(env: Env, authorization: string | null): Promise<boolean> {
  const user = await getAuthUser(env, authorization);
  return Boolean(user);
}

function badRequest(env: Env, message: string) {
  return jsonResponse(env, 400, { error: message });
}

function unauthorized(env: Env, message = 'unauthorized') {
  return jsonResponse(env, 401, { error: message });
}

// 내부 API는 x-voc-token 또는 HMAC 서명으로만 허용한다.
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

function parsePage(rawValue: string | null, fallback = 1, max = 1000) {
  const parsed = Number(rawValue || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

type PrivateReviewSortBy = 'reviewed_at' | 'author' | 'rating' | 'priority' | 'category' | 'issue_label' | 'summary';
type SortDirection = 'asc' | 'desc';
type NormalizedPriority = 'Critical' | 'High' | 'Normal';
type NormalizedCategory = '버그 및 성능' | '계정 및 결제' | '콘텐츠 및 운영 정책' | '기능 및 사용성' | '긍정 리뷰 및 기타';

// -----------------------------------------------------------------------------
// 입력 정규화 / 표시용 파생 값
// -----------------------------------------------------------------------------

const ALLOWED_CATEGORIES: NormalizedCategory[] = [
  '버그 및 성능',
  '계정 및 결제',
  '콘텐츠 및 운영 정책',
  '기능 및 사용성',
  '긍정 리뷰 및 기타',
];

function parsePrivateReviewSortBy(rawValue: string | null): PrivateReviewSortBy {
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

function parseSortDirection(rawValue: string | null, fallback: SortDirection = 'desc'): SortDirection {
  const normalized = (rawValue || '').trim().toLowerCase();
  if (normalized === 'asc' || normalized === 'desc') {
    return normalized;
  }
  return fallback;
}

function parseRatingFilter(rawValue: string | null) {
  if (!rawValue) {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizePriorityFilter(rawValue: string | null) {
  const normalized = (rawValue || '').trim();
  if (!normalized) {
    return null;
  }
  if (normalized === 'Critical' || normalized === 'High' || normalized === 'Normal') {
    return normalized;
  }
  return null;
}

function normalizeSearchKeyword(rawValue: string | null, maxLength = 80) {
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

function normalizeVocCategory(rawCategory: unknown, rawSummary?: unknown, rawContent?: unknown): NormalizedCategory {
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

function normalizePriorityValue(rawPriority: unknown): NormalizedPriority {
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

function normalizeIssueLabel(rawIssueLabel: unknown, category: NormalizedCategory, summary?: unknown) {
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

function normalizeReasonSummary(rawReasonSummary: unknown, summary?: unknown) {
  const normalized = String(rawReasonSummary ?? '').trim();
  if (normalized) {
    return normalized.slice(0, 200);
  }

  const fallback = String(summary ?? '').trim();
  return fallback ? fallback.slice(0, 200) : '원인 요약 없음';
}

function defaultActionHint(category: NormalizedCategory) {
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

function normalizeActionHint(rawActionHint: unknown, category: NormalizedCategory) {
  const normalized = String(rawActionHint ?? '').trim();
  if (normalized) {
    return normalized.slice(0, 200);
  }
  return defaultActionHint(category);
}

function derivePriorityValue(rating: number, category: NormalizedCategory, rawPriority: unknown): NormalizedPriority {
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
    // webhook은 중복 호출 시 부작용이 생길 수 있어 재시도 대상에서 제외한다.
    idempotent: false,
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

// 작업 상태 업데이트 공통 함수.
// RPC가 실패/0건이어도 직접 PATCH로 한 번 더 보장한다.
async function completePipelineJob(
  env: Env,
  input: {
    jobId?: string | null;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
    runId?: string | null;
    errorMessage?: string | null;
  },
): Promise<{ updated: boolean; data: Record<string, unknown> | null }> {
  const normalizedJobId = (input.jobId || '').trim();
  if (!isUuid(normalizedJobId)) {
    return { updated: false, data: null };
  }

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await supabaseRequest<Array<Record<string, unknown>>>(env, '/rest/v1/rpc/complete_pipeline_job', {
      method: 'POST',
      body: JSON.stringify({
        p_job_id: normalizedJobId,
        p_status: input.status,
        p_run_id: normalizeOptionalText(input.runId, 120),
        p_error_message: normalizeOptionalText(input.errorMessage, 300),
      }),
      idempotent: true,
    });
  } catch {
    rows = [];
  }

  if (rows.length > 0) {
    return { updated: true, data: rows[0] || null };
  }

  const now = new Date().toISOString();
  const patchBody: Record<string, unknown> = {
    status: input.status,
    updated_at: now,
  };

  if (input.runId) {
    patchBody.run_id = input.runId;
  }

  if (input.status === 'running') {
    patchBody.started_at = now;
  }

  if (['completed', 'failed', 'canceled'].includes(input.status)) {
    patchBody.finished_at = now;
  }

  patchBody.error_message = input.status === 'failed' ? input.errorMessage || null : null;

  const fallbackRows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_jobs?id=eq.${encodeURIComponent(normalizedJobId)}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patchBody),
      idempotent: true,
    },
  );

  return { updated: fallbackRows.length > 0, data: fallbackRows[0] || null };
}

type PipelineStage = 'queued' | 'fetching' | 'extracting' | 'clustering' | 'publishing';

async function updatePipelineJobStage(
  env: Env,
  jobId: string | null | undefined,
  stage: PipelineStage | null,
  runId?: string | null,
) {
  if (!isUuid(jobId)) return;
  const patch: Record<string, unknown> = { stage, updated_at: new Date().toISOString() };
  if (runId) patch.run_id = runId;
  await supabaseRequest(env, `/rest/v1/pipeline_jobs?id=eq.${encodeURIComponent(String(jobId))}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    idempotent: true,
  });
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
  const windowDays = clampLimit(
    String(body?.windowDays ?? DEFAULT_FETCH_WINDOW_DAYS),
    DEFAULT_FETCH_WINDOW_DAYS,
    MAX_FETCH_WINDOW_DAYS,
  );
  const maxPages = clampLimit(
    String(body?.maxPages ?? DEFAULT_FETCH_MAX_PAGES),
    DEFAULT_FETCH_MAX_PAGES,
    MAX_FETCH_MAX_PAGES,
  );
  const limitCap = clampLimit(String(body?.limit ?? MAX_FETCH_REVIEW_CAP), MAX_FETCH_REVIEW_CAP, MAX_FETCH_REVIEW_CAP);
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const reviews: NormalizedReview[] = [];
  const seenIds = new Set<string>();
  let pagesFetched = 0;
  let truncated = false;
  let rssFirstPageError: string | null = null;

  for (let page = 1; page <= maxPages && reviews.length < limitCap; page += 1) {
    // Apple RSS currently returns the standard 50-review page without a limit segment.
    // Keeping /limit=50/ in this path can yield an incomplete feed or a 403 from edge networks.
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appStoreId}/sortby=mostrecent/json`;
    const response = await fetchWithRetry(env, url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'VoC-Radar/0.2',
      },
      timeoutMs: 30000,
      retries: 2,
      idempotent: true,
    });

    if (!response.ok) {
      const text = await response.text();
      if (page === 1) {
        rssFirstPageError = `iTunes RSS fetch failed (${response.status}): ${text}`;
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
    let reachedOlderReviews = false;
    for (const entry of entries) {
      const reviewId = String((entry.id as { label?: string } | undefined)?.label ?? entry.id ?? '').trim();
      const rating = normalizeRating((entry['im:rating'] as { label?: string } | undefined)?.label ?? entry['im:rating']);
      const reviewedAt = normalizeReviewedAt((entry.updated as { label?: string } | undefined)?.label ?? entry.updated);
      const reviewedAtMs = new Date(reviewedAt).getTime();

      if (!reviewId || rating <= 0 || seenIds.has(reviewId)) {
        continue;
      }
      if (!Number.isFinite(reviewedAtMs) || reviewedAtMs < cutoff) {
        reachedOlderReviews = true;
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
        reviewedAt,
      });

      if (reviews.length >= limitCap) {
        truncated = true;
        break;
      }
    }

    if (reachedOlderReviews) {
      break;
    }
    if (addedInPage === 0) {
      break;
    }
  }

  // Some apps or Apple edge locations return an empty/blocked RSS feed.
  // The storefront review-row endpoint is the current fallback for the KR storefront.
  if (reviews.length === 0 && country === 'kr') {
    for (let page = 0; page < maxPages && reviews.length < limitCap; page += 1) {
      const startIndex = page * ITUNES_USER_REVIEW_PAGE_SIZE;
      const endIndex = startIndex + ITUNES_USER_REVIEW_PAGE_SIZE - 1;
      const url =
        'https://itunes.apple.com/WebObjects/MZStore.woa/wa/userReviewsRow' +
        `?cc=${country}&id=${appStoreId}&displayable-kind=11&startIndex=${startIndex}&endIndex=${endIndex}&sort=4`;
      const response = await fetchWithRetry(env, url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          referer: `https://apps.apple.com/${country}/app/id${appStoreId}`,
          'user-agent':
            'iTunes/12.12.10 (Windows; Microsoft Windows 10 x64 Business Edition (Build 19045); x64) AppleWebKit/7613.300.10.1',
          'x-apple-store-front': '143466-13,29',
        },
        timeoutMs: 30000,
        retries: 2,
        idempotent: true,
      });

      if (!response.ok) {
        if (page === 0 && rssFirstPageError) {
          throw new Error(rssFirstPageError);
        }
        break;
      }

      const payload = (await response.json()) as {
        userReviewList?: Array<Record<string, unknown>>;
      };
      const entries = Array.isArray(payload.userReviewList) ? payload.userReviewList : [];
      if (entries.length === 0) {
        break;
      }

      pagesFetched += 1;
      let reachedOlderReviews = false;
      for (const entry of entries) {
        const reviewId = String(entry.userReviewId || '').trim();
        const rating = normalizeRating(entry.rating);
        const reviewedAt = normalizeReviewedAt(entry.date);
        const reviewedAtMs = new Date(reviewedAt).getTime();

        if (!reviewId || rating <= 0 || seenIds.has(reviewId)) {
          continue;
        }
        if (!Number.isFinite(reviewedAtMs) || reviewedAtMs < cutoff) {
          reachedOlderReviews = true;
          continue;
        }

        seenIds.add(reviewId);
        reviews.push({
          reviewId,
          author: String(entry.name || 'unknown').trim(),
          content: String(entry.body || '').trim(),
          rating,
          reviewedAt,
        });

        if (reviews.length >= limitCap) {
          truncated = true;
          break;
        }
      }

      if (reachedOlderReviews) {
        break;
      }
    }
  }

  if (reviews.length === 0 && rssFirstPageError) {
    throw new Error(rssFirstPageError);
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      appStoreId,
      country,
      windowDays,
      maxPages,
      limitCap,
      pagesFetched,
      reviews,
      totalFetched: reviews.length,
      truncated,
    },
  });
}

// -----------------------------------------------------------------------------
// Public API: 로그인 없이 읽는 집계/목록/리뷰 조회
// -----------------------------------------------------------------------------

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
    `/rest/v1/pipeline_runs?select=app_store_id,country,executed_at,published_at,updated_at,review_count,status&status=in.(upserted,published)&review_count=gt.0&order=executed_at.desc&limit=${runLimit}`,
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

  const data = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/apps?select=app_store_id,country,app_name,updated_at&or=(app_name.ilike.*${encodeURIComponent(query)}*,app_store_id.ilike.*${encodeURIComponent(query)}*)&order=updated_at.desc.nullslast&limit=${limit}`,
    {
      method: 'GET',
      idempotent: true,
    },
  );

  return jsonResponse(env, 200, { data });
}

type AppleCatalogItem = {
  trackId?: number;
  trackName?: string;
  artworkUrl100?: string;
  bundleId?: string;
  sellerName?: string;
};

function extractAppStoreId(value: string) {
  const trimmed = value.trim();
  const direct = normalizeAppStoreId(trimmed);
  if (direct) return direct;
  const match = trimmed.match(/(?:\/id|\bid)(\d{5,20})(?:\b|[/?#])/i);
  return normalizeAppStoreId(match?.[1]);
}

async function fetchAppleCatalog(env: Env, query: string, country: string, limit: number) {
  const appId = extractAppStoreId(query);
  const url = appId
    ? `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${country.toUpperCase()}`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=${country.toUpperCase()}&entity=software&limit=${limit}`;
  const response = await fetchWithRetry(env, url, {
    method: 'GET',
    timeoutMs: 15000,
    retries: 2,
    idempotent: true,
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { results?: AppleCatalogItem[] };
  return Array.isArray(payload.results) ? payload.results : [];
}

async function handlePublicDiscover(env: Env, request: Request) {
  const { searchParams } = new URL(request.url);
  const query = normalizeSearchKeyword(searchParams.get('q'), 180);
  const country = normalizeCountry(searchParams.get('country'));
  const limit = clampLimit(searchParams.get('limit'), 8, 12);
  if (!query) {
    const runs = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_runs?select=app_store_id,country,published_at,updated_at&status=eq.published&order=published_at.desc.nullslast&limit=${limit * 4}`,
      { method: 'GET', idempotent: true },
    );
    const seen = new Set<string>();
    const recent = [];
    for (const run of runs) {
      const id = normalizeAppStoreId(String(run.app_store_id || ''));
      const appCountry = normalizeCountry(String(run.country || country));
      if (!id || seen.has(`${id}:${appCountry}`)) continue;
      seen.add(`${id}:${appCountry}`);
      const apps = await supabaseRequest<Array<Record<string, unknown>>>(
        env,
        `/rest/v1/apps?select=app_name&app_store_id=eq.${encodeURIComponent(id)}&country=eq.${encodeURIComponent(appCountry)}&limit=1`,
        { method: 'GET', idempotent: true },
      );
      recent.push({
        appStoreId: id,
        country: appCountry,
        appName: normalizeOptionalText(apps[0]?.app_name, 120),
        artworkUrl: null,
        bundleId: null,
        developerName: null,
        analyzed: true,
        lastAnalyzedAt: run.published_at || run.updated_at || null,
        source: 'catalog',
      });
      if (recent.length >= limit) break;
    }
    return jsonResponse(env, 200, { data: recent });
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
  return jsonResponse(env, 200, { data });
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
    return jsonResponse(env, 404, { error: 'report_v2_disabled' });
  }
  const { searchParams } = new URL(request.url);
  const appId = normalizeAppStoreId(searchParams.get('appId'));
  const country = normalizeCountry(searchParams.get('country'));
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (!appId) return badRequest(env, 'appId is required');

  const [overviewRows, categories, trends, issues, runs, apps] = await Promise.all([
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
  ]);

  const overview = overviewRows[0] || {};
  const run = runs[0] || null;
  let appName = normalizeOptionalText(apps[0]?.app_name, 120);
  if (!appName) {
    const catalog = await fetchAppleCatalog(env, appId, country, 1);
    appName = normalizeOptionalText(catalog[0]?.trackName, 120);
  }
  const lastAnalyzedAt = run?.published_at || run?.updated_at || null;
  const totalReviews = Number(overview.total_reviews || 0);
  const lowRatingCount = Number(overview.low_rating_count || 0);
  const data = {
    app: {
      appStoreId: appId,
      country,
      appName,
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
  return jsonResponse(env, 200, { data });
}

async function handlePublicIssueDetail(env: Env, request: Request, issueId: string) {
  if (!boolFromEnv(env.REPORT_V2_ENABLED, false)) {
    return jsonResponse(env, 404, { error: 'report_v2_disabled' });
  }
  if (!isUuid(issueId)) return badRequest(env, 'issue id must be uuid');
  const data = await supabaseRequest<Record<string, unknown> | null>(env, '/rest/v1/rpc/get_public_issue_detail', {
    method: 'POST',
    body: JSON.stringify({ p_issue_id: issueId }),
    idempotent: true,
  });
  if (!data) return jsonResponse(env, 404, { error: 'issue not found' });
  return jsonResponse(env, 200, { data });
}

async function getPublicRunsForApp(env: Env, appId: string, country: string, limit = 5) {
  return supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_runs?select=run_id,app_store_id,country,source,status,review_count,model_version,validation_status,executed_at,published_at,updated_at&app_store_id=eq.${encodeURIComponent(appId)}&country=eq.${encodeURIComponent(country)}&order=executed_at.desc&limit=${limit}`,
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
  const cooldownUntil = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const freshRuns = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_runs?select=run_id,app_store_id,country,status,published_at,model_version&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&published_at=gte.${encodeURIComponent(cooldownUntil)}&order=published_at.desc&limit=1`,
    { method: 'GET', idempotent: true },
  );
  const freshRun = freshRuns[0];
  if (freshRun) {
    const publishedAt = String(freshRun.published_at || now);
    return jsonResponse(env, 200, {
      ok: true,
      result: 'fresh',
      data: {
        runId: freshRun.run_id,
        appStoreId,
        country,
        publishedAt,
        nextAllowedAt: new Date(new Date(publishedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  }

  // A refresh can complete without a new published run when the App Store feed has
  // no unseen reviews. Treat that successful check as a cooldown boundary too.
  const completedJobs = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_jobs?select=id,run_id,finished_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.completed&finished_at=gte.${encodeURIComponent(cooldownUntil)}&order=finished_at.desc&limit=1`,
    { method: 'GET', idempotent: true },
  );
  const completedJob = completedJobs[0];
  if (completedJob) {
    const latestRuns = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_runs?select=run_id,published_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&order=published_at.desc&limit=1`,
      { method: 'GET', idempotent: true },
    );
    const completedAt = String(completedJob.finished_at || now);
    const latestRun = latestRuns[0];
    return jsonResponse(env, 200, {
      ok: true,
      result: 'fresh',
      data: {
        runId: latestRun?.run_id || completedJob.run_id || null,
        appStoreId,
        country,
        publishedAt: latestRun?.published_at || completedAt,
        nextAllowedAt: new Date(new Date(completedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  }

  const activeJobsPath = `/rest/v1/pipeline_jobs?select=id,app_store_id,country,app_name,status,stage,run_id,requested_at,updated_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=in.(queued,running)&order=requested_at.asc&limit=1`;
  const activeJobs = await supabaseRequest<Array<Record<string, unknown>>>(env, activeJobsPath, {
    method: 'GET',
    idempotent: true,
  });
  if (activeJobs[0]) {
    return jsonResponse(env, 200, { ok: true, result: 'existing', data: activeJobs[0] });
  }

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
          stage: 'queued',
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
    if (message.includes('23505') || message.toLowerCase().includes('duplicate key')) {
      const racedJobs = await supabaseRequest<Array<Record<string, unknown>>>(env, activeJobsPath, {
        method: 'GET',
        idempotent: true,
      });
      if (racedJobs[0]) {
        return jsonResponse(env, 200, { ok: true, result: 'existing', data: racedJobs[0] });
      }
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

  // 요청 저장 후 n8n webhook 즉시 호출(실패해도 폴링으로 처리 가능)
  const trigger = await triggerN8nPipeline(env, {
    jobId: String(created.id || '').trim(),
    appStoreId,
    country,
    requestedAt: now,
  });

  return jsonResponse(env, 201, {
    ok: true,
    result: 'queued',
    data: created,
    trigger,
  });
}

// -----------------------------------------------------------------------------
// Private API: 로그인 사용자 작업 제어
// -----------------------------------------------------------------------------

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
      `/rest/v1/pipeline_jobs?select=id,app_store_id,country,app_name,source,status,stage,run_id,note,error_message,requested_at,started_at,finished_at,created_at,updated_at&order=created_at.desc&limit=${limit}`,
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

async function handlePrivateCancelJobs(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  const user = await getAuthUser(env, authorization);
  if (!user) {
    return unauthorized(env, 'invalid access token');
  }

  let body: CancelPipelineJobsRequest;
  try {
    body = (await request.json()) as CancelPipelineJobsRequest;
  } catch {
    return badRequest(env, 'invalid json body');
  }

  const cancelAll = body?.cancelAll === true;
  const jobId = (body?.jobId || '').trim();
  if (!cancelAll && !jobId) {
    return badRequest(env, 'jobId is required when cancelAll is false');
  }

  if (jobId && !isUuid(jobId)) {
    return badRequest(env, 'jobId must be uuid');
  }

  const appStoreId = body?.appStoreId ? normalizeAppStoreId(body.appStoreId) : null;
  const country = body?.country ? normalizeCountry(body.country) : null;

  const query = new URLSearchParams();
  query.set('requested_by', `eq.${user.id}`);
  query.set('status', 'in.(queued,running)');
  if (jobId) {
    query.set('id', `eq.${jobId}`);
  }
  if (cancelAll && appStoreId) {
    query.set('app_store_id', `eq.${appStoreId}`);
  }
  if (cancelAll && country) {
    query.set('country', `eq.${country}`);
  }

  const now = new Date().toISOString();
  const updatedRows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_jobs?${query.toString()}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        status: 'canceled',
        error_message: 'Canceled by user',
        finished_at: now,
        updated_at: now,
      }),
      idempotent: true,
    },
  );

  return jsonResponse(env, 200, {
    ok: true,
    canceledCount: updatedRows.length,
    data: updatedRows,
  });
}

async function handlePrivateDeleteAccount(env: Env, request: Request) {
  const authorization = request.headers.get('authorization');
  const user = await getAuthUser(env, authorization);
  if (!user) {
    return unauthorized(env, 'invalid access token');
  }

  const now = new Date().toISOString();
  const updatedRows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_jobs?requested_by=eq.${encodeURIComponent(user.id)}&status=in.(queued,running)`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        status: 'canceled',
        error_message: 'Canceled by account deletion',
        finished_at: now,
        updated_at: now,
      }),
      idempotent: true,
    },
  );

  await deleteSupabaseAuthUser(env, user.id);

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      deleted: true,
      canceledJobs: updatedRows.length,
    },
  });
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
  const jobId = (body?.jobId || '').toString().trim();
  const runId = normalizeOptionalText(body?.runId, 120);
  const forceReanalysis = body?.forceReanalysis === true;

  const completeJobIfNoNewReviews = async () => completePipelineJob(env, {
    jobId,
    status: 'completed',
    runId,
  });

  const inputReviews = Array.isArray(body?.reviews) ? body.reviews : [];
  if (inputReviews.length === 0) {
    await completeJobIfNoNewReviews();
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [], autoCompleted: isUuid(jobId) },
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
    await completeJobIfNoNewReviews();
    return jsonResponse(env, 200, {
      ok: true,
      data: { total: 0, existingCount: 0, newCount: 0, reviews: [], autoCompleted: isUuid(jobId) },
    });
  }

  // 이미 적재된 review_id를 먼저 제외해서 중복 분석/중복 저장을 막는다.
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
  let existingExtractions: Array<Record<string, unknown>> = [];
  if (existingIds.size > 0) {
    const idFilter = [...existingIds].map((id) => encodeURIComponent(id)).join(',');
    const rows = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/private_review_feed?select=review_id,rating,author,content,reviewed_at,priority,category,summary&review_id=in.(${idFilter})`,
      { method: 'GET', idempotent: true },
    );
    existingExtractions = rows.map((row) => ({
      ID: row.review_id,
      id: row.review_id,
      rating: row.rating,
      author: row.author,
      content: row.content,
      date: row.reviewed_at,
      priority: row.priority,
      category: row.category,
      summary: row.summary,
      appStoreId,
      country,
      runId,
      jobId: jobId || null,
      isExisting: true,
    }));
  }

  if (freshReviews.length === 0 && !forceReanalysis) {
    await completeJobIfNoNewReviews();
  } else {
    await updatePipelineJobStage(env, jobId, 'extracting', runId);
  }

  return jsonResponse(env, 200, {
    ok: true,
    data: {
      total: normalizedReviews.length,
      existingCount: existingIds.size,
      newCount: freshReviews.length,
      reviews: freshReviews,
      existingExtractions,
      autoCompleted: freshReviews.length === 0 && !forceReanalysis && isUuid(jobId),
      forceReanalysis,
    },
  });
}

// -----------------------------------------------------------------------------
// Internal API: n8n 파이프라인 전용
// -----------------------------------------------------------------------------

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

  if (jobId) await updatePipelineJobStage(env, jobId, 'fetching');

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

  const requestedStage = body.stage ?? null;
  if (![null, 'queued', 'fetching', 'extracting', 'clustering', 'publishing'].includes(requestedStage)) {
    return badRequest(env, 'invalid stage');
  }

  const result = await completePipelineJob(env, {
    jobId: normalizedJobId,
    status: normalizedStatus as 'queued' | 'running' | 'completed' | 'failed' | 'canceled',
    runId: normalizeOptionalText(body.runId, 120),
    errorMessage: normalizeOptionalText(body.errorMessage, 300),
  });

  await updatePipelineJobStage(env, normalizedJobId, requestedStage, body.runId);

  const data = result.data || null;
  return jsonResponse(env, 200, { ok: true, data });
}

function buildReviewFeedFilters(input: {
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
  cursor: string | null;
}) {
  const queryLimit = Math.min(input.limit + 1, 101);
  const offset = Math.max(0, (input.page - 1) * input.limit);
  const order =
    input.sortBy === 'reviewed_at' ? `${input.sortBy}.${input.sortDirection}` : `${input.sortBy}.${input.sortDirection},reviewed_at.desc`;

  const filters = new URLSearchParams({
    app_store_id: `eq.${input.appId}`,
    country: `eq.${input.country}`,
    order,
    limit: String(queryLimit),
  });

  if (input.cursor) {
    filters.set('reviewed_at', `lt.${input.cursor}`);
  } else {
    filters.set('offset', String(offset));
  }

  if (input.rating != null) {
    filters.set('rating', `eq.${input.rating}`);
  }
  if (input.priority) {
    filters.set('priority', `eq.${input.priority}`);
  }
  if (input.category) {
    filters.set('category', `eq.${input.category}`);
  }
  if (input.issueLabel) {
    filters.set('issue_label', `eq.${input.issueLabel}`);
  }
  if (input.search) {
    const pattern = `*${input.search}*`;
    filters.set(
      'or',
      `(author.ilike.${pattern},summary.ilike.${pattern},category.ilike.${pattern},issue_label.ilike.${pattern},reason_summary.ilike.${pattern},action_hint.ilike.${pattern},content.ilike.${pattern})`,
    );
  }

  return filters;
}

// 리뷰 피드는 검색/정렬/커서 조건을 Worker에서 한 번 더 정규화한다.
function normalizeReviewFeedRows(rows: Array<Record<string, unknown>>, limit: number) {
  let hasNext = rows.length > limit;
  let slicedRows = rows;
  if (hasNext) {
    slicedRows = rows.slice(0, limit);
  }

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

  const last = normalizedRows[normalizedRows.length - 1] as { reviewed_at?: string } | undefined;
  return {
    data: normalizedRows,
    hasNext,
    nextCursor: hasNext ? (last?.reviewed_at ?? null) : null,
  };
}

async function handlePublicReviews(env: Env, request: Request) {
  if (!boolFromEnv(env.DETAIL_VIEW_ENABLED, true)) {
    return jsonResponse(env, 403, { error: 'detail view disabled' });
  }

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

  if (!appId) {
    return badRequest(env, 'appId must be numeric');
  }

  const filters = buildReviewFeedFilters({
    appId,
    country,
    limit,
    page,
    sortBy,
    sortDirection,
    rating,
    priority,
    category,
    issueLabel,
    search,
    cursor,
  });

  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, `/rest/v1/private_review_feed?${filters.toString()}`, {
    method: 'GET',
    idempotent: true,
  });

  const normalized = normalizeReviewFeedRows(rows, limit);
  return jsonResponse(env, 200, { data: normalized.data, page, limit, hasNext: normalized.hasNext, nextCursor: normalized.nextCursor });
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

  if (!appId) {
    return badRequest(env, 'appId must be numeric');
  }

  const filters = buildReviewFeedFilters({
    appId,
    country,
    limit,
    page,
    sortBy,
    sortDirection,
    rating,
    priority,
    category,
    issueLabel,
    search,
    cursor,
  });

  // private reviews는 Worker에서 access token만 검증하고, 실제 조회는 service_role로 수행한다.
  // 이렇게 하면 view를 authenticated에 직접 노출하지 않아도 된다.
  const data = await supabaseRequest<Array<Record<string, unknown>>>(env, `/rest/v1/private_review_feed?${filters.toString()}`, {
    method: 'GET',
    idempotent: true,
  });

  const normalized = normalizeReviewFeedRows(data, limit);
  return jsonResponse(env, 200, {
    data: normalized.data,
    page,
    limit,
    hasNext: normalized.hasNext,
    nextCursor: normalized.nextCursor,
  });
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

    const aiRows = body.reviews.map((review) => {
      const summary = review.summary || '분류 결과 없음';
      const content = review.content || '';
      const normalizedCategory = normalizeVocCategory(review.category || '긍정 리뷰 및 기타', summary, content);
      const normalizedPriority = derivePriorityValue(review.rating, normalizedCategory, review.priority || 'Normal');
      const issueLabel = normalizeIssueLabel(review.issueLabel, normalizedCategory, summary);
      const reasonSummary = normalizeReasonSummary(review.reasonSummary, summary);
      const actionHint = normalizeActionHint(review.actionHint, normalizedCategory);

      return {
        review_id: review.reviewId,
        priority: normalizedPriority,
        category: normalizedCategory,
        issue_label: issueLabel,
        reason_summary: reasonSummary,
        action_hint: actionHint,
        summary,
        confidence: review.confidence ?? null,
        model_version: review.modelVersion ?? 'gemini',
        updated_at: now,
      };
    });

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
    await completePipelineJob(env, {
      jobId: body.jobId,
      status: 'running',
      runId: body.runId,
    });
    await updatePipelineJobStage(env, body.jobId, 'clustering', body.runId);
  }

  return jsonResponse(env, 200, {
    ok: true,
    runId: body.runId,
    upsertedReviews: reviewRows.length,
  });
}

async function handleInternalUpsertClusters(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');

  let body: UpsertClustersRequest;
  try {
    body = JSON.parse(rawBody) as UpsertClustersRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }

  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  const country = normalizeCountry(body?.country);
  const modelVersion = normalizeOptionalText(body?.modelVersion, 120);
  const comparisonEligible = body?.comparisonEligible !== false;
  if (!body?.runId || !appStoreId || !modelVersion || !Array.isArray(body.inputReviewIds)) {
    return badRequest(env, 'invalid payload');
  }

  let validated;
  try {
    validated = validateClusterContract(body.inputReviewIds, body.result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'cluster validation failed';
    await supabaseRequest(env, `/rest/v1/pipeline_runs?run_id=eq.${encodeURIComponent(body.runId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        model_version: modelVersion,
        validation_status: 'failed',
        validation_result: { passed: false, error: message },
        updated_at: new Date().toISOString(),
      }),
      idempotent: true,
    });
    if (isUuid(body.jobId || undefined)) {
      await completePipelineJob(env, {
        jobId: body.jobId,
        status: 'failed',
        runId: body.runId,
        errorMessage: message,
      });
    }
    return jsonResponse(env, 422, { error: 'cluster_contract_invalid', detail: message });
  }

  const reviewIds = validated.extractions.map((item) => item.reviewId);
  const reviewFilter = reviewIds.map((id) => encodeURIComponent(id)).join(',');
  const reviewRows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/reviews?select=review_id,reviewed_at&review_id=in.(${reviewFilter})`,
    { method: 'GET', idempotent: true },
  );
  const reviewedAtById = new Map(reviewRows.map((row) => [String(row.review_id || ''), String(row.reviewed_at || '')]));
  const missingReviewIds = reviewIds.filter((id) => !reviewedAtById.has(id));
  if (missingReviewIds.length > 0) {
    return jsonResponse(env, 422, { error: 'unknown_review_ids', reviewIds: missingReviewIds });
  }

  const existingClusters = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/issue_clusters?select=id,canonical_key,first_seen_at,last_seen_at,current_run_id&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}`,
    { method: 'GET', idempotent: true },
  );
  const existingByKey = new Map(existingClusters.map((row) => [String(row.canonical_key || ''), row]));
  for (const cluster of validated.clusters) {
    const existing = existingByKey.get(cluster.canonicalKey);
    if (cluster.existingClusterId && String(existing?.id || '') !== cluster.existingClusterId) {
      return jsonResponse(env, 422, {
        error: 'existing_cluster_mismatch',
        canonicalKey: cluster.canonicalKey,
      });
    }
  }

  const now = new Date().toISOString();
  const clusterRows = validated.clusters.map((cluster) => {
    const existing = existingByKey.get(cluster.canonicalKey);
    const occurrences = cluster.reviewIds.map((id) => reviewedAtById.get(id) || now).sort();
    const firstSeenCandidates = [existing?.first_seen_at, ...occurrences]
      .map((value) => String(value || ''))
      .filter((value) => Number.isFinite(new Date(value).getTime()))
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const lastSeenCandidates = [existing?.last_seen_at, ...occurrences]
      .map((value) => String(value || ''))
      .filter((value) => Number.isFinite(new Date(value).getTime()))
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return {
      app_store_id: appStoreId,
      country,
      canonical_key: cluster.canonicalKey,
      title: cluster.title,
      category: cluster.category,
      first_seen_at: firstSeenCandidates[0] || now,
      last_seen_at: lastSeenCandidates[lastSeenCandidates.length - 1] || now,
      model_version: modelVersion,
      updated_at: now,
    };
  });

  const persistedClusters = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    '/rest/v1/issue_clusters?on_conflict=app_store_id,country,canonical_key',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(clusterRows),
      idempotent: true,
    },
  );
  const persistedByKey = new Map(persistedClusters.map((row) => [String(row.canonical_key || ''), row]));

  const previousCounts = new Map<string, number>();
  if (comparisonEligible) {
    await Promise.all(
      existingClusters.map(async (existing) => {
        const clusterId = String(existing.id || '');
        const previousRunId = String(existing.current_run_id || '');
        if (!clusterId || !previousRunId) return;
        const rows = await supabaseRequest<Array<Record<string, unknown>>>(
          env,
          `/rest/v1/issue_cluster_snapshots?select=review_count&cluster_id=eq.${encodeURIComponent(clusterId)}&run_id=eq.${encodeURIComponent(previousRunId)}&limit=1`,
          { method: 'GET', idempotent: true },
        );
        if (rows[0]) previousCounts.set(clusterId, Number(rows[0].review_count || 0));
      }),
    );
  }

  const validationResult = { ...validated.validation, comparisonEligible };

  const snapshots = validated.clusters.map((cluster) => {
    const persisted = persistedByKey.get(cluster.canonicalKey);
    const clusterId = String(persisted?.id || '');
    if (!clusterId) throw new Error(`cluster persistence failed: ${cluster.canonicalKey}`);
    const previousReviewCount = previousCounts.get(clusterId);
    return {
      cluster_id: clusterId,
      run_id: body.runId,
      severity: cluster.severity,
      review_count: cluster.reviewIds.length,
      previous_review_count: previousReviewCount ?? null,
      change_percent:
        previousReviewCount && previousReviewCount > 0
          ? Number((((cluster.reviewIds.length - previousReviewCount) / previousReviewCount) * 100).toFixed(1))
          : null,
      evidence_count: cluster.reviewIds.length,
      summary: cluster.summary,
      action_hint: cluster.actionHint,
      window_from: body.windowFrom || null,
      window_to: body.windowTo || null,
      validation_status: 'passed',
      validation_result: validationResult,
      created_at: now,
    };
  });

  await supabaseRequest(env, '/rest/v1/issue_cluster_snapshots?on_conflict=cluster_id,run_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(snapshots),
    idempotent: true,
  });

  await supabaseRequest(env, `/rest/v1/issue_cluster_reviews?run_id=eq.${encodeURIComponent(body.runId)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
    idempotent: true,
  });
  const memberships = validated.clusters.flatMap((cluster) => {
    const clusterId = String(persistedByKey.get(cluster.canonicalKey)?.id || '');
    return cluster.reviewIds.map((reviewId) => ({
      run_id: body.runId,
      review_id: reviewId,
      cluster_id: clusterId,
      is_representative: cluster.representativeReviewIds.includes(reviewId),
    }));
  });
  await supabaseRequest(env, '/rest/v1/issue_cluster_reviews?on_conflict=run_id,review_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(memberships),
    idempotent: true,
  });

  await supabaseRequest(env, `/rest/v1/pipeline_runs?run_id=eq.${encodeURIComponent(body.runId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      model_version: modelVersion,
      validation_status: 'passed',
      validation_result: validationResult,
      updated_at: now,
    }),
    idempotent: true,
  });
  if (isUuid(body.jobId || undefined)) {
    await supabaseRequest(env, `/rest/v1/pipeline_jobs?id=eq.${encodeURIComponent(String(body.jobId))}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', stage: 'publishing', run_id: body.runId, updated_at: now }),
      idempotent: true,
    });
  }

  return jsonResponse(env, 200, {
    ok: true,
    runId: body.runId,
    clusterCount: snapshots.length,
    assignedReviewCount: memberships.length,
    validation: validationResult,
  });
}

async function handleInternalClusterContext(env: Env, request: Request, rawBody: string) {
  const verified = await verifySignedRequest(env, request, rawBody);
  if (!verified) return unauthorized(env, 'invalid signature');
  let body: ClusterContextRequest;
  try {
    body = JSON.parse(rawBody) as ClusterContextRequest;
  } catch {
    return badRequest(env, 'invalid payload');
  }
  const appStoreId = normalizeAppStoreId(body?.appStoreId);
  const country = normalizeCountry(body?.country);
  if (!appStoreId) return badRequest(env, 'appStoreId must be numeric');
  const runs = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/pipeline_runs?select=run_id&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&status=eq.published&validation_status=eq.passed&order=published_at.desc.nullslast,updated_at.desc&limit=1`,
    { method: 'GET', idempotent: true },
  );
  const latestRunId = normalizeOptionalText(runs[0]?.run_id, 120);
  if (!latestRunId) return jsonResponse(env, 200, { ok: true, data: [] });
  const data = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/issue_clusters?select=id,canonical_key,title,category,first_seen_at,last_seen_at&app_store_id=eq.${encodeURIComponent(appStoreId)}&country=eq.${encodeURIComponent(country)}&current_run_id=eq.${encodeURIComponent(latestRunId)}&order=updated_at.desc&limit=100`,
    { method: 'GET', idempotent: true },
  );
  return jsonResponse(env, 200, {
    ok: true,
    data: data.map((row) => ({
      issueId: row.id,
      canonicalKey: row.canonical_key,
      title: row.title,
      category: row.category,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
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
    await completePipelineJob(env, {
      jobId: body.jobId,
      status: 'failed',
      runId: normalizeOptionalText(body.runId, 120),
      errorMessage: normalizeOptionalText(body.message, 300),
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

  if (boolFromEnv(env.REPORT_V2_ENABLED, false)) {
    const runs = await supabaseRequest<Array<Record<string, unknown>>>(
      env,
      `/rest/v1/pipeline_runs?select=validation_status&run_id=eq.${encodeURIComponent(body.runId)}&limit=1`,
      { method: 'GET', idempotent: true },
    );
    if (runs[0]?.validation_status !== 'passed') {
      return jsonResponse(env, 409, { error: 'cluster_validation_required' });
    }
  }

  const publishedAt = body.publishedAt || new Date().toISOString();

  await supabaseRequest(env, '/rest/v1/pipeline_runs?run_id=eq.' + encodeURIComponent(body.runId), {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'published',
      published_at: publishedAt,
      updated_at: new Date().toISOString(),
    }),
    idempotent: true,
  });

  const snapshots = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `/rest/v1/issue_cluster_snapshots?select=cluster_id&run_id=eq.${encodeURIComponent(body.runId)}`,
    { method: 'GET', idempotent: true },
  );
  const clusterIds = [...new Set(snapshots.map((row) => String(row.cluster_id || '')).filter(isUuid))];
  if (clusterIds.length > 0) {
    await supabaseRequest(env, `/rest/v1/issue_clusters?id=in.(${clusterIds.join(',')})`, {
      method: 'PATCH',
      body: JSON.stringify({ current_run_id: body.runId, updated_at: new Date().toISOString() }),
      idempotent: true,
    });
  }

  if (isUuid(body.jobId || undefined)) {
    await completePipelineJob(env, {
      jobId: body.jobId,
      status: 'completed',
      runId: body.runId,
    });
    await updatePipelineJobStage(env, body.jobId, null, body.runId);
  }

  await setCacheVersion(env, String(Date.now()));

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

  const rows = body.alerts.map((alert) => {
    const normalizedCategory = normalizeVocCategory(alert.category, alert.summary, '');
    const normalizedPriority = derivePriorityValue(alert.rating, normalizedCategory, alert.priority);

    return {
      event_id: `${body.appStoreId}_${normalizedCountry}_${alert.reviewId}`,
      run_id: body.runId,
      review_id: alert.reviewId,
      app_store_id: body.appStoreId,
      country: normalizedCountry,
      rating: alert.rating,
      priority: normalizedPriority,
      category: normalizedCategory,
      summary: alert.summary,
      sent_at: alert.sentAt || new Date().toISOString(),
    };
  });

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

// -----------------------------------------------------------------------------
// Request router
// -----------------------------------------------------------------------------

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSupabaseKeepalive(env)
        .then(() => {
          console.log(`[keepalive] success cron=${controller.cron} at=${new Date(controller.scheduledTime).toISOString()}`);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'unknown error';
          console.error(
            `[keepalive] failed cron=${controller.cron} at=${new Date(controller.scheduledTime).toISOString()} error=${message}`,
          );
          throw error;
        }),
    );
  },

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
          reportV2Enabled: boolFromEnv(env.REPORT_V2_ENABLED, false),
          timestamp: new Date().toISOString(),
        });
      }

      // Public API: 로그인 없이 조회 가능한 집계 데이터
      if (request.method === 'GET' && url.pathname === '/api/public/discover') {
        return await handlePublicDiscover(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/report') {
        return await handlePublicReport(env, request);
      }

      const issueDetailMatch = url.pathname.match(/^\/api\/public\/issues\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && issueDetailMatch) {
        return await handlePublicIssueDetail(env, request, issueDetailMatch[1] || '');
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

      if (request.method === 'GET' && url.pathname === '/api/public/dashboard') {
        return await handlePublicDashboard(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/issues') {
        return await handlePublicIssues(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/reviews') {
        return await handlePublicReviews(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/apps') {
        return await handlePublicApps(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/apps/search') {
        return await handlePublicAppsSearch(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/app-meta') {
        return await handlePublicAppMeta(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/public/runs') {
        return await handlePublicRuns(env, request);
      }

      // Private API: 로그인 사용자 전용 데이터/작업 제어
      if (request.method === 'GET' && url.pathname === '/api/private/jobs') {
        return await handlePrivateJobs(env, request);
      }

      if (request.method === 'DELETE' && url.pathname === '/api/private/account') {
        return await handlePrivateDeleteAccount(env, request);
      }

      if (request.method === 'POST' && url.pathname === '/api/private/jobs/cancel') {
        return await handlePrivateCancelJobs(env, request);
      }

      if (request.method === 'POST' && url.pathname === '/api/private/jobs') {
        return await handlePrivateCreateJob(env, request);
      }

      if (request.method === 'GET' && url.pathname === '/api/private/reviews') {
        return await handlePrivateReviews(env, request);
      }

      // Internal API: n8n 전용 파이프라인 엔드포인트
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

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/upsert-clusters') {
        return await handleInternalUpsertClusters(env, request, await request.text());
      }

      if (request.method === 'POST' && url.pathname === '/api/internal/pipeline/cluster-context') {
        return await handleInternalClusterContext(env, request, await request.text());
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
