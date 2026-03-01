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
  summary: string;
  confidence: number | null;
}

export interface PublicAppItem {
  app_store_id: string;
  country: string;
  app_name: string | null;
  updated_at: string;
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
