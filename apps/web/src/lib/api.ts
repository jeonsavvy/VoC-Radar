import type {
  PrivateReviewItem,
  PublicCategoryPoint,
  PublicOverview,
  PublicTrendPoint,
} from '../types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || '10000');
const REQUEST_RETRY_COUNT = Number(import.meta.env.VITE_API_RETRY_COUNT || '2');

const shouldRetry = (method: string, status?: number) => {
  const upper = method.toUpperCase();
  const idempotent = upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
  const serverError = typeof status === 'number' ? status >= 500 : true;
  return idempotent && serverError;
};

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

        throw new Error(`API ${response.status}: ${text || response.statusText}`);
      }

      return (await response.json()) as T;
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

export async function getOverview(appId: string, country = 'kr') {
  const params = new URLSearchParams({ appId, country });
  return fetchJson<{ data: PublicOverview }>(`/api/public/overview?${params.toString()}`);
}

export async function getTrends(appId: string, country = 'kr', from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country });
  if (from) {
    params.set('from', from);
  }
  if (to) {
    params.set('to', to);
  }

  return fetchJson<{ data: PublicTrendPoint[] }>(`/api/public/trends?${params.toString()}`);
}

export async function getCategories(appId: string, country = 'kr', from?: string, to?: string) {
  const params = new URLSearchParams({ appId, country });
  if (from) {
    params.set('from', from);
  }
  if (to) {
    params.set('to', to);
  }

  return fetchJson<{ data: PublicCategoryPoint[] }>(`/api/public/categories?${params.toString()}`);
}

export async function getPrivateReviews(
  appId: string,
  accessToken: string,
  country = 'kr',
  cursor?: string,
  limit = 25,
) {
  const params = new URLSearchParams({ appId, country, limit: String(limit) });
  if (cursor) {
    params.set('cursor', cursor);
  }

  return fetchJson<{ data: PrivateReviewItem[]; nextCursor: string | null }>(
    `/api/private/reviews?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
}
