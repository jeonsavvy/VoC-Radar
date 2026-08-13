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
export function parseApiIntegerConfig(
  value: unknown,
  fallback: number,
  minimum: 0 | 1,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (typeof value === 'string' && !value.trim()) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

// Browsers clamp larger setTimeout delays into a near-immediate timeout.
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
const REQUEST_TIMEOUT_MS = parseApiIntegerConfig(
  import.meta.env.VITE_API_TIMEOUT_MS,
  10000,
  1,
  MAX_TIMEOUT_DELAY_MS,
);
const REQUEST_RETRY_COUNT = parseApiIntegerConfig(import.meta.env.VITE_API_RETRY_COUNT, 2, 0);
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

type Decoder<T> = (value: unknown) => T;

const invalidSuccessResponse = (status: number) => new ApiError(SERVICE_RESPONSE_ERROR, {
  status,
  code: 'invalid_response',
  retryable: true,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isTimestamp = (value: unknown): value is string => isString(value) && Number.isFinite(Date.parse(value));
const isNullableTimestamp = (value: unknown): value is string | null => value === null || isTimestamp(value);

function decodeEnvelopeData<T>(value: unknown, decodeData: Decoder<T>): { data: T } {
  if (!isRecord(value) || !('data' in value)) throw new Error('missing data envelope');
  return { data: decodeData(value.data) };
}

const decodeIssueCluster: Decoder<PublicReport['issues'][number]> = (value) => {
  if (!isRecord(value)
    || !isString(value.issueId)
    || !isString(value.title)
    || !isString(value.category)
    || !['high', 'medium', 'low'].includes(String(value.severity))
    || !isNumber(value.reviewCount)
    || !(value.changePercent === null || isNumber(value.changePercent))
    || !isNumber(value.evidenceCount)
    || !isNullableTimestamp(value.lastOccurredAt)
    || !isString(value.summary)
    || !isNullableString(value.actionHint)
    || !isString(value.runId)
    || !isString(value.modelVersion)
    || !isNullableTimestamp(value.analyzedAt)) {
    throw new Error('invalid issue cluster');
  }
  return value as unknown as PublicReport['issues'][number];
};

const decodePublicReport: Decoder<PublicReport> = (value) => {
  if (!isRecord(value) || !isRecord(value.window) || !isTimestamp(value.window.from)
    || !isTimestamp(value.window.to) || Date.parse(value.window.from) > Date.parse(value.window.to)
    || !isRecord(value.app) || !isString(value.app.appStoreId) || !isString(value.app.country)
    || !isNullableString(value.app.appName) || !isNullableString(value.app.artworkUrl)
    || !isRecord(value.summary) || !isNumber(value.summary.totalReviews)
    || !isNumber(value.summary.issueCount) || !isNumber(value.summary.averageRating)
    || !isNumber(value.summary.lowRatingCount) || !isNumber(value.summary.lowRatingRatio)
    || !isNumber(value.summary.positiveRatio) || !isNullableTimestamp(value.summary.lastReviewAt)
    || !isRecord(value.analysis) || !['analyzed', 'not_analyzed'].includes(String(value.analysis.status))
    || !isNullableString(value.analysis.runId) || !isNullableString(value.analysis.modelVersion)
    || !isNullableTimestamp(value.analysis.lastAnalyzedAt) || typeof value.analysis.stale !== 'boolean'
    || !Array.isArray(value.issues) || !Array.isArray(value.categories) || !Array.isArray(value.trends)) {
    throw new Error('invalid public report');
  }
  value.issues.forEach(decodeIssueCluster);
  if (!value.categories.every((item) => isRecord(item) && isString(item.category)
    && isNumber(item.totalReviews) && isNumber(item.sharePercent))) throw new Error('invalid report categories');
  if (!value.trends.every((item) => isRecord(item) && isTimestamp(item.date)
    && isNumber(item.totalReviews) && isNumber(item.averageRating))) throw new Error('invalid report trends');
  return value as unknown as PublicReport;
};

const decodeReviewsResponse: Decoder<ReviewsResponse> = (value) => {
  if (!isRecord(value) || !Array.isArray(value.data) || !isNumber(value.page) || !isNumber(value.limit)
    || typeof value.hasNext !== 'boolean' || !isNullableString(value.nextCursor)) {
    throw new Error('invalid reviews envelope');
  }
  const validPriorities: Priority[] = ['Critical', 'High', 'Normal'];
  if (!value.data.every((item) => isRecord(item)
    && ['review_id', 'app_store_id', 'country', 'author', 'content', 'category', 'issue_label',
      'reason_summary', 'action_hint', 'summary'].every((key) => isString(item[key]))
    && isNumber(item.rating) && isTimestamp(item.reviewed_at)
    && validPriorities.includes(item.priority as Priority)
    && (item.confidence === null || isNumber(item.confidence)))) {
    throw new Error('invalid review item');
  }
  return value as unknown as ReviewsResponse;
};

const decodeIssueDetail: Decoder<IssueDetail> = (value) => {
  if (!isRecord(value) || !isRecord(value.issue) || !Array.isArray(value.reviews)) {
    throw new Error('invalid issue detail');
  }
  decodeIssueCluster(value.issue);
  if (!isString(value.issue.appStoreId) || !isString(value.issue.country) || !isRecord(value.issue.validation)
    || !value.reviews.every((review) => isRecord(review) && isString(review.reviewId)
      && isNumber(review.rating) && isString(review.author) && isString(review.content)
      && isTimestamp(review.reviewedAt) && isNullableString(review.summary)
      && typeof review.isRepresentative === 'boolean')) {
    throw new Error('invalid issue detail fields');
  }
  return value as unknown as IssueDetail;
};

const decodeDiscoveryResponse: Decoder<{ data: DiscoveryItem[] }> = (value) => decodeEnvelopeData(value, (data) => {
  if (!Array.isArray(data) || !data.every((item) => isRecord(item)
    && isString(item.appStoreId) && isString(item.country) && isNullableString(item.appName)
    && isNullableString(item.artworkUrl) && isNullableString(item.bundleId)
    && isNullableString(item.developerName) && typeof item.analyzed === 'boolean'
    && isNullableTimestamp(item.lastAnalyzedAt) && ['catalog', 'app_store'].includes(String(item.source)))) {
    throw new Error('invalid discovery response');
  }
  return data as DiscoveryItem[];
});

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
    signal?: AbortSignal;
    decode?: Decoder<T>;
  } = {},
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const retries = Math.max(0, REQUEST_RETRY_COUNT);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new ApiError(SERVICE_REQUEST_ERROR, { code: 'request_aborted', retryable: false });
    }
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

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
        const parsed: unknown = JSON.parse(text);
        return options.decode ? options.decode(parsed) : parsed as T;
      } catch {
        throw invalidSuccessResponse(response.status);
      }
    } catch (error) {
      const normalizedError = error instanceof ApiError ? error
        : options.signal?.aborted
          ? new ApiError(SERVICE_REQUEST_ERROR, { code: 'request_aborted', retryable: false })
          : timedOut
            ? new ApiError(SERVICE_CONNECTION_ERROR, { code: 'request_timeout', retryable: true })
            : new ApiError(SERVICE_CONNECTION_ERROR, { code: 'network_error', retryable: true });
      if (attempt >= retries || !shouldRetry(method, normalizedError)) throw normalizedError;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
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
    signal?: AbortSignal;
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

  return fetchJson<ReviewsResponse>(`/api/public/reviews?${params.toString()}`, {
    signal: options?.signal,
    decode: decodeReviewsResponse,
  });
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

export async function discoverApps(query = '', country = DEFAULT_COUNTRY, limit = 8, signal?: AbortSignal) {
  const params = new URLSearchParams({
    q: query,
    country,
    limit: String(limit),
  });
  return fetchJson<{ data: DiscoveryItem[] }>(`/api/public/discover?${params.toString()}`, {
    signal,
    decode: decodeDiscoveryResponse,
  });
}

export function getPublicArtworkUrl(appId: string, country = DEFAULT_COUNTRY) {
  const params = new URLSearchParams({
    appId,
    country,
  });
  return `${API_BASE_URL}/api/public/artwork?${params.toString()}`;
}

export async function getPublicReport(appId: string, country = DEFAULT_COUNTRY, signal?: AbortSignal) {
  const params = new URLSearchParams({ appId, country });
  return fetchJson<{ data: PublicReport }>(`/api/public/report?${params.toString()}`, {
    signal,
    decode: (value) => decodeEnvelopeData(value, decodePublicReport),
  });
}

export async function getIssueDetail(issueId: string, from: string, to: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ from, to });
  return fetchJson<{ data: IssueDetail }>(
    `/api/public/issues/${encodeURIComponent(issueId)}?${params.toString()}`,
    { signal, decode: (value) => decodeEnvelopeData(value, decodeIssueDetail) },
  );
}
