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
