// Worker가 처리하는 요청/응답 payload의 기준 타입 모음이다.
// Web, n8n, Supabase 사이에서 오가는 필드 이름을 여기서 고정한다.
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

// 분석 결과 upsert payload:
// 리뷰 원문과 AI 분류 결과를 한 번에 적재할 때 사용한다.
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
    issueLabel?: string | null;
    reasonSummary?: string | null;
    actionHint?: string | null;
    summary: string;
    confidence?: number | null;
    modelVersion?: string | null;
    rawSource?: unknown;
  }>;
}

// 파싱 실패 payload:
// LLM 응답이나 후처리 단계에서 구조화하지 못한 원문을 기록한다.
export interface ParseErrorRequest {
  parseErrorId: string;
  jobId?: string;
  runId?: string;
  appStoreId?: string;
  country?: string;
  message: string;
  rawResponse: string;
}

// publish payload:
// 공개 캐시 버전을 갱신하고 run 상태를 published로 확정한다.
export interface PublishRequest {
  runId: string;
  appStoreId: string;
  country: string;
  jobId?: string | null;
  publishedAt?: string;
}

// alert payload:
// Critical/High 등 후속 알림이 필요한 리뷰를 별도 기록한다.
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

// Web에서 생성하는 수집 요청 payload다.
export interface CreatePipelineJobRequest {
  appStoreId: string;
  country?: string;
  appName?: string;
  note?: string;
}

// n8n이 queue에서 작업을 가져갈 때 사용하는 payload다.
export interface ClaimJobRequest {
  allowFallback?: boolean;
  fallbackAppStoreId?: string;
  fallbackCountry?: string;
  fallbackAppName?: string;
}

// 파이프라인이 queue 상태를 직접 갱신할 때 사용하는 payload다.
export interface JobStatusRequest {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  runId?: string;
  errorMessage?: string;
}

// 신규 리뷰만 남기기 위한 preflight payload다.
export interface FilterNewReviewsRequest {
  appStoreId: string;
  country?: string;
  runId?: string;
  jobId?: string | null;
  reviews: Array<{
    reviewId: string;
    author?: string;
    content?: string;
    rating?: number | string;
    reviewedAt?: string;
  }>;
}

// App Store RSS 수집 요청 payload다.
export interface FetchReviewsRequest {
  appStoreId: string;
  country?: string;
  windowDays?: number;
  maxPages?: number;
  limit?: number;
}

// 사용자가 queue 작업을 취소할 때 사용하는 payload다.
export interface CancelPipelineJobsRequest {
  jobId?: string;
  cancelAll?: boolean;
  appStoreId?: string;
  country?: string;
}
