import type {
  AppSearchItem,
  CancelPipelineJobsResponse,
  CreatePipelineJobResponse,
  DashboardResponse,
  IssuePriorityItem,
  PipelineJobItem,
  Priority,
  PrivateReviewSortKey,
  PrivateReviewsResponse,
  PublicAppItem,
  PublicAppMeta,
  PublicCategoryPoint,
  PublicOverview,
  PublicTrendPoint,
  RunSummaryItem,
} from '@/types';

// api.ts는 Web에서 Worker API를 호출할 때 사용하는 공용 클라이언트다.
// 모든 요청은 timeout, retry, JSON 파싱 검증을 같은 규칙으로 처리한다.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || '10000');
const REQUEST_RETRY_COUNT = Number(import.meta.env.VITE_API_RETRY_COUNT || '2');

const CONFIG_HINT =
  'API 응답이 JSON이 아닙니다. VITE_API_BASE_URL이 Worker URL(https://voc-radar-api...workers.dev)인지 확인하세요.';

const shouldRetry = (method: string, status?: number) => {
  const upper = method.toUpperCase();
  const idempotent = upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
  const serverError = typeof status === 'number' ? status >= 500 : true;
  return idempotent && serverError;
};

const isHtmlPayload = (contentType: string | null, body: string) => {
  const lowerType = (contentType || '').toLowerCase();
  const trimmed = body.trim().toLowerCase();
  return lowerType.includes('text/html') || trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
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
        if (attempt < retries && shouldRetry(method, response.status)) {
          continue;
        }

        if (isHtmlPayload(response.headers.get('content-type'), text)) {
          throw new Error(CONFIG_HINT);
        }

        throw new Error(`API ${response.status}: ${text || response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      const text = await response.text();

      if (isHtmlPayload(contentType, text)) {
        throw new Error(CONFIG_HINT);
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error('API 응답 파싱에 실패했습니다. Worker/API 상태를 확인하세요.');
      }
    } catch (error) {
      if (attempt >= retries || !shouldRetry(method)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('요청 재시도 한도를 초과했습니다.');
}

export async function getOverview(appId: string, country = 'kr', from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson<{ data: PublicOverview }>(`/api/public/overview?${params.toString()}`);
}

export async function getDashboard(appId: string, country = 'kr', from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson<{ data: DashboardResponse }>(`/api/public/dashboard?${params.toString()}`);
}

export async function getIssues(appId: string, country = 'kr', limit = 10, from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country, limit: String(limit) });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson<{ data: IssuePriorityItem[] }>(`/api/public/issues?${params.toString()}`);
}

export async function searchApps(query: string, limit = 8) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return fetchJson<{ data: AppSearchItem[] }>(`/api/public/apps/search?${params.toString()}`);
}

export async function getRuns(appId: string, country = 'kr', limit = 5) {
  const params = new URLSearchParams({ appId, country, limit: String(limit) });
  return fetchJson<{ data: RunSummaryItem[] }>(`/api/public/runs?${params.toString()}`);
}

export async function getTrends(appId: string, country = 'kr', from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson<{ data: PublicTrendPoint[] }>(`/api/public/trends?${params.toString()}`);
}

export async function getCategories(appId: string, country = 'kr', from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson<{ data: PublicCategoryPoint[] }>(`/api/public/categories?${params.toString()}`);
}

export async function getPrivateReviews(
  appId: string,
  accessToken: string,
  options?: {
    country?: string;
    page?: number;
    limit?: number;
    sortBy?: PrivateReviewSortKey;
    sortDirection?: 'asc' | 'desc';
    rating?: 1 | 2 | 3 | 4 | 5;
    priority?: Priority;
    category?: string;
    issueLabel?: string;
    search?: string;
    cursor?: string;
  },
) {
  const params = new URLSearchParams({
    appId,
    country: options?.country || 'kr',
    limit: String(options?.limit ?? 25),
    page: String(options?.page ?? 1),
  });

  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDirection) params.set('sortDirection', options.sortDirection);
  if (options?.rating) params.set('rating', String(options.rating));
  if (options?.priority) params.set('priority', options.priority);
  if (options?.category?.trim()) params.set('category', options.category.trim());
  if (options?.issueLabel?.trim()) params.set('issueLabel', options.issueLabel.trim());
  if (options?.search?.trim()) params.set('search', options.search.trim());
  if (options?.cursor) params.set('cursor', options.cursor);

  return fetchJson<PrivateReviewsResponse>(`/api/private/reviews?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

export async function getPublicReviews(
  appId: string,
  options?: {
    country?: string;
    page?: number;
    limit?: number;
    sortBy?: PrivateReviewSortKey;
    sortDirection?: 'asc' | 'desc';
    rating?: 1 | 2 | 3 | 4 | 5;
    priority?: Priority;
    category?: string;
    search?: string;
    cursor?: string;
  },
) {
  const params = new URLSearchParams({
    appId,
    country: options?.country || 'kr',
    limit: String(options?.limit ?? 25),
    page: String(options?.page ?? 1),
  });

  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDirection) params.set('sortDirection', options.sortDirection);
  if (options?.rating) params.set('rating', String(options.rating));
  if (options?.priority) params.set('priority', options.priority);
  if (options?.category?.trim()) params.set('category', options.category.trim());
  if (options?.search?.trim()) params.set('search', options.search.trim());
  if (options?.cursor) params.set('cursor', options.cursor);

  return fetchJson<PrivateReviewsResponse>(`/api/public/reviews?${params.toString()}`);
}

export async function getPublicApps(limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson<{ data: PublicAppItem[] }>(`/api/public/apps?${params.toString()}`);
}

export async function getPublicAppMeta(appId: string, country = 'kr') {
  const params = new URLSearchParams({ appId, country });
  return fetchJson<{ data: PublicAppMeta }>(`/api/public/app-meta?${params.toString()}`);
}

export async function createPipelineJob(
  accessToken: string,
  payload: { appStoreId: string; country: string; appName?: string; note?: string },
) {
  // 수집 요청 생성은 비공개 API이므로 access token이 필요하다.
  return fetchJson<CreatePipelineJobResponse>(`/api/private/jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
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

export async function cancelPipelineJobs(
  accessToken: string,
  payload: { jobId?: string; cancelAll?: boolean; appStoreId?: string; country?: string },
) {
  return fetchJson<CancelPipelineJobsResponse>(`/api/private/jobs/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
}
