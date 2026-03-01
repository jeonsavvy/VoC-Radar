export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  PIPELINE_WEBHOOK_SECRET: string;
  N8N_PIPELINE_TRIGGER_URL?: string;
  N8N_PIPELINE_TRIGGER_SECRET?: string;
  DETAIL_VIEW_ENABLED?: string;
  API_TIMEOUT_MS?: string;
  API_RETRY_COUNT?: string;
  CORS_ORIGIN?: string;
  CACHE_STATE?: KVNamespace;
}

export interface UpsertReviewRequest {
  runId: string;
  source: string;
  jobId?: string | null;
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
  jobId?: string;
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
  jobId?: string | null;
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

export interface CreatePipelineJobRequest {
  appStoreId: string;
  country?: string;
  appName?: string;
  note?: string;
}

export interface ClaimJobRequest {
  allowFallback?: boolean;
  fallbackAppStoreId?: string;
  fallbackCountry?: string;
  fallbackAppName?: string;
}

export interface JobStatusRequest {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  runId?: string;
  errorMessage?: string;
}

export interface FilterNewReviewsRequest {
  appStoreId: string;
  country?: string;
  reviews: Array<{
    reviewId: string;
    author?: string;
    content?: string;
    rating?: number | string;
    reviewedAt?: string;
  }>;
}

export interface FetchReviewsRequest {
  appStoreId: string;
  country?: string;
  limit?: number;
}

export interface CancelPipelineJobsRequest {
  jobId?: string;
  cancelAll?: boolean;
  appStoreId?: string;
  country?: string;
}
