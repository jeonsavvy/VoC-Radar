export type Priority = 'Critical' | 'High' | 'Normal';

export interface PublicOverview {
  app_store_id: string;
  country: string;
  total_reviews: number;
  critical_count: number;
  low_rating_count: number;
  average_rating: number;
  positive_ratio: number;
  last_review_at: string | null;
}

export interface PublicTrendPoint {
  bucket_date: string;
  total_reviews: number;
  critical_count: number;
  average_rating: number;
}

export interface PublicCategoryPoint {
  category: string;
  total_reviews: number;
  share_percent: number;
}

export interface PrivateReviewItem {
  review_id: string;
  app_store_id: string;
  country: string;
  rating: number;
  author: string;
  content: string;
  reviewed_at: string;
  priority: Priority;
  category: string;
  issue_label: string;
  reason_summary: string;
  action_hint: string;
  summary: string;
  confidence: number | null;
}

export type PrivateReviewSortKey = 'reviewed_at' | 'author' | 'rating' | 'priority' | 'category' | 'issue_label' | 'summary';

export interface PrivateReviewsResponse {
  data: PrivateReviewItem[];
  page: number;
  limit: number;
  hasNext: boolean;
  nextCursor: string | null;
}

export interface PublicAppItem {
  app_store_id: string;
  country: string;
  app_name: string | null;
  updated_at: string;
}

export interface PublicAppMeta {
  app_store_id: string;
  country: string;
  app_name: string | null;
  source: 'supabase' | 'itunes' | 'unknown';
}

export interface AppSearchItem {
  app_store_id: string;
  country: string;
  app_name: string | null;
  updated_at: string;
}

export interface RunSummaryItem {
  run_id: string;
  app_store_id: string;
  country: string;
  source: string;
  status: 'upserted' | 'published' | 'failed';
  review_count: number;
  executed_at: string;
  published_at: string | null;
  updated_at: string;
}

export interface IssuePriorityItem {
  issue_label: string;
  category: string;
  review_count: number;
  critical_count: number;
  low_rating_count: number;
  average_rating: number;
  last_review_at: string;
  previous_review_count: number;
  change_percent: number | null;
  reason_summary: string | null;
  action_hint: string | null;
}

export interface DashboardEvidenceItem {
  review_id: string;
  reviewed_at: string;
  rating: number;
  author: string;
  priority: Priority;
  category: string;
  issue_label: string;
  summary: string;
  action_hint: string;
  content: string;
}

export interface DashboardSummary {
  app_store_id: string;
  country: string;
  app_name: string | null;
  total_reviews: number;
  issue_count: number;
  critical_count: number;
  low_rating_count: number;
  low_rating_ratio: number;
  average_rating: number;
  positive_ratio: number;
  last_review_at: string | null;
  last_published_at: string | null;
  latest_run_status: RunSummaryItem['status'] | 'idle';
}

export interface DashboardResponse {
  summary: DashboardSummary;
  categories: PublicCategoryPoint[];
  trends: PublicTrendPoint[];
  issues: IssuePriorityItem[];
  evidence: DashboardEvidenceItem[];
  runs: RunSummaryItem[];
}

export interface PipelineJobItem {
  id: string;
  app_store_id: string;
  country: string;
  app_name: string | null;
  source: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  run_id: string | null;
  note: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineTriggerResult {
  dispatched: boolean;
  reason?: string;
  statusCode?: number;
  detail?: string;
}

export interface CreatePipelineJobResponse {
  ok: true;
  data: PipelineJobItem;
  trigger?: PipelineTriggerResult;
}

export interface CancelPipelineJobsResponse {
  ok: true;
  canceledCount: number;
  data: PipelineJobItem[];
}
