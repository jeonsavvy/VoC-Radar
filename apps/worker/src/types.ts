export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  PIPELINE_WEBHOOK_SECRET: string;
  DETAIL_VIEW_ENABLED?: string;
  API_TIMEOUT_MS?: string;
  API_RETRY_COUNT?: string;
  CORS_ORIGIN?: string;
  CACHE_STATE?: KVNamespace;
}

export interface UpsertReviewRequest {
  runId: string;
  source: string;
  app: {
    appStoreId: string;
    country: string;
    appName?: string;
  };
  reviews: Array<{
    reviewId: string;
    rating: number;
    author: string;
    content: string;
    reviewedAt: string;
    priority: string;
    category: string;
    summary: string;
    confidence?: number | null;
    modelVersion?: string | null;
    rawSource?: unknown;
  }>;
}

export interface ParseErrorRequest {
  parseErrorId: string;
  runId?: string;
  appStoreId?: string;
  country?: string;
  message: string;
  rawResponse: string;
}

export interface PublishRequest {
  runId: string;
  appStoreId: string;
  country: string;
  publishedAt?: string;
}

export interface AlertEventsRequest {
  runId: string;
  appStoreId: string;
  country: string;
  alerts: Array<{
    reviewId: string;
    rating: number;
    priority: string;
    category: string;
    summary: string;
    sentAt?: string;
  }>;
}
