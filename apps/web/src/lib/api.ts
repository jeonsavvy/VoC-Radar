import type {
  AnalysisRequestResponse,
  DiscoveryItem,
  IssueDetail,
  PipelineJobItem,
  Priority,
  PublicReport,
  ReviewSortKey,
  ReviewsResponse,
} from '@/types';
import { DEFAULT_COUNTRY } from '@/lib/config';

// api.ts는 Web에서 Worker API를 호출할 때 사용하는 공용 클라이언트다.
// 모든 요청은 timeout, retry, JSON 파싱 검증을 같은 규칙으로 처리한다.
// Web과 API는 하나의 Worker에서 제공하므로 기본값은 same-origin이다.
// 분리된 로컬 API나 임시 검증 환경에서만 VITE_API_BASE_URL을 지정한다.
const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';
const API_BASE_URL = configuredApiBaseUrl.replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || '10000');
const REQUEST_RETRY_COUNT = Number(import.meta.env.VITE_API_RETRY_COUNT || '2');
const PUBLIC_ARTWORK_CACHE_REVISION = '2';

const SERVICE_RESPONSE_ERROR = '서비스 응답을 처리하지 못했습니다.';
const SERVICE_REQUEST_ERROR = '서비스 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.';
const SERVICE_CONNECTION_ERROR = '서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.';

export type ApiErrorEnvelope = {
  ok: false;
  error: string;
  message: string;
  requestId: string;
  retryable: boolean;
};

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number | null; code?: string; requestId?: string | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? null;
    this.code = options.code || 'request_failed';
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
  }
}

const isIdempotentMethod = (method: string) => ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

const shouldRetry = (method: string, error: ApiError) => isIdempotentMethod(method) && error.retryable;

const parseApiErrorEnvelope = (body: string): ApiErrorEnvelope | null => {
  try {
    const parsed = JSON.parse(body) as Partial<ApiErrorEnvelope> | null;
    if (
      !parsed
      || parsed.ok !== false
      || typeof parsed.error !== 'string'
      || typeof parsed.message !== 'string'
      || typeof parsed.requestId !== 'string'
      || typeof parsed.retryable !== 'boolean'
    ) return null;

    const error = parsed.error.trim().slice(0, 120);
    const message = parsed.message.trim().slice(0, 300);
    const requestId = parsed.requestId.trim().slice(0, 120);
    if (!error || !message || !requestId) return null;
    return { ok: false, error, message, requestId, retryable: parsed.retryable };
  } catch {
    return null;
  }
};

const isHtmlPayload = (contentType: string | null, body: string) => {
  const lowerType = (contentType || '').toLowerCase();
  const trimmed = body.trim().toLowerCase();
  return lowerType.includes('text/html') || trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
};

const createResponseError = (response: Response, body: string) => {
  if (isHtmlPayload(response.headers.get('content-type'), body)) {
    return new ApiError(SERVICE_RESPONSE_ERROR, {
      status: response.status,
      code: 'invalid_response',
      retryable: response.status >= 500,
    });
  }

  const envelope = parseApiErrorEnvelope(body);
  if (envelope) {
    return new ApiError(envelope.message, {
      status: response.status,
      code: envelope.error,
      requestId: envelope.requestId,
      retryable: envelope.retryable,
    });
  }

  return new ApiError(SERVICE_REQUEST_ERROR, {
    status: response.status,
    code: 'invalid_error_response',
    retryable: response.status >= 500,
  });
};

// fetchJson은 Web이 Worker와 통신할 때 지키는 기본 계약이다.
// - JSON 응답만 허용한다.
// - GET 계열 요청만 재시도한다.
// - HTML이 오면 잘못된 API_BASE_URL로 판단한다.
async function fetchJson<T>(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const retries = Math.max(0, REQUEST_RETRY_COUNT);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const responseError = createResponseError(response, text);
        if (attempt < retries && shouldRetry(method, responseError)) continue;
        throw responseError;
      }

      const contentType = response.headers.get('content-type');
      const text = await response.text();

      if (isHtmlPayload(contentType, text)) {
        throw new ApiError(SERVICE_RESPONSE_ERROR, {
          status: response.status,
          code: 'invalid_response',
          retryable: true,
        });
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError(SERVICE_RESPONSE_ERROR, {
          status: response.status,
          code: 'invalid_response',
          retryable: true,
        });
      }
    } catch (error) {
      const normalizedError = error instanceof ApiError
        ? error
        : new ApiError(SERVICE_CONNECTION_ERROR, { code: 'network_error', retryable: true });
      if (attempt >= retries || !shouldRetry(method, normalizedError)) throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ApiError(SERVICE_REQUEST_ERROR);
}

export async function getPublicReviews(
  appId: string,
  options?: {
    country?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
    sortBy?: ReviewSortKey;
    sortDirection?: 'asc' | 'desc';
    rating?: 1 | 2 | 3 | 4 | 5;
    priority?: Priority;
    category?: string;
    search?: string;
    searchScope?: 'content';
    cursor?: string;
  },
) {
  const params = new URLSearchParams({
    appId,
    country: options?.country || DEFAULT_COUNTRY,
    limit: String(options?.limit ?? 25),
    page: String(options?.page ?? 1),
  });

  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDirection) params.set('sortDirection', options.sortDirection);
  if (options?.rating) params.set('rating', String(options.rating));
  if (options?.priority) params.set('priority', options.priority);
  if (options?.category?.trim()) params.set('category', options.category.trim());
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);
  if (options?.search?.trim()) params.set('search', options.search.trim());
  if (options?.searchScope) params.set('searchScope', options.searchScope);
  if (options?.cursor) params.set('cursor', options.cursor);

  return fetchJson<ReviewsResponse>(`/api/public/reviews?${params.toString()}`);
}

export async function getMyPipelineJobs(accessToken: string, limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson<{ data: PipelineJobItem[] }>(`/api/private/jobs?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

export async function requestAnalysis(
  accessToken: string,
  payload: { appStoreId: string; country: string; appName?: string; note?: string },
) {
  return fetchJson<AnalysisRequestResponse>(`/api/private/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  });
}

export async function deleteAccount(accessToken: string) {
  return fetchJson<{ ok: true; data: { deleted: true; canceledJobs: number; redactedJobs: number } }>(`/api/private/account`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

export async function discoverApps(query = '', country = DEFAULT_COUNTRY, limit = 8) {
  const params = new URLSearchParams({
    q: query,
    country,
    limit: String(limit),
    artworkRevision: PUBLIC_ARTWORK_CACHE_REVISION,
  });
  return fetchJson<{ data: DiscoveryItem[] }>(`/api/public/discover?${params.toString()}`);
}

export async function getPublicReport(appId: string, country = DEFAULT_COUNTRY, from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country, artworkRevision: PUBLIC_ARTWORK_CACHE_REVISION });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson<{ data: PublicReport }>(`/api/public/report?${params.toString()}`);
}

export async function getIssueDetail(issueId: string, from: string, to: string) {
  const params = new URLSearchParams({ from, to });
  return fetchJson<{ data: IssueDetail }>(
    `/api/public/issues/${encodeURIComponent(issueId)}?${params.toString()}`,
  );
}
