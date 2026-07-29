export type Priority = 'Critical' | 'High' | 'Normal';

export interface ReviewItem {
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

export type ReviewSortKey = 'reviewed_at' | 'author' | 'rating' | 'priority' | 'category' | 'issue_label' | 'summary';

export interface ReviewsResponse {
  data: ReviewItem[];
  page: number;
  limit: number;
  hasNext: boolean;
  nextCursor: string | null;
}

export interface PipelineJobItem {
  id: string;
  app_store_id: string;
  country: string;
  app_name: string | null;
  source: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  stage?: 'queued' | 'fetching' | 'extracting' | 'clustering' | 'publishing' | null;
  run_id: string | null;
  note: string | null;
  failure_code?: 'review_scope_incomplete' | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisRequestJob {
  id: string;
  app_store_id: string;
  country: string;
  app_name?: string | null;
  status: PipelineJobItem['status'];
  stage?: PipelineJobItem['stage'];
  run_id?: string | null;
  requested_at: string;
  updated_at?: string;
}

export interface PipelineTriggerResult {
  dispatched: boolean;
  reason?: string;
  statusCode?: number;
  detail?: string;
}

export type IssueSeverity = 'high' | 'medium' | 'low';

export interface DiscoveryItem {
  appStoreId: string;
  country: string;
  appName: string | null;
  artworkUrl: string | null;
  bundleId: string | null;
  developerName: string | null;
  analyzed: boolean;
  lastAnalyzedAt: string | null;
  source: 'catalog' | 'app_store';
}

export interface IssueClusterItem {
  issueId: string;
  title: string;
  category: string;
  severity: IssueSeverity;
  reviewCount: number;
  changePercent: number | null;
  evidenceCount: number;
  lastOccurredAt: string | null;
  summary: string;
  actionHint: string | null;
  runId: string;
  modelVersion: string;
  analyzedAt: string | null;
}

export interface PublicReport {
  app: { appStoreId: string; country: string; appName: string | null; artworkUrl: string | null };
  summary: {
    totalReviews: number;
    issueCount: number;
    averageRating: number;
    lowRatingCount: number;
    lowRatingRatio: number;
    positiveRatio: number;
    lastReviewAt: string | null;
  };
  analysis: {
    status: 'analyzed' | 'not_analyzed';
    runId: string | null;
    modelVersion: string | null;
    lastAnalyzedAt: string | null;
    stale: boolean;
  };
  issues: IssueClusterItem[];
  categories: Array<{ category: string; totalReviews: number; sharePercent: number }>;
  trends: Array<{ date: string; totalReviews: number; averageRating: number }>;
}

export interface IssueEvidenceReview {
  reviewId: string;
  rating: number;
  author: string;
  content: string;
  reviewedAt: string;
  summary: string | null;
  isRepresentative: boolean;
}

export interface IssueDetail {
  issue: IssueClusterItem & {
    appStoreId: string;
    country: string;
    validation: Record<string, unknown>;
  };
  reviews: IssueEvidenceReview[];
}

export type AnalysisRequestResponse =
  | { ok: true; result: 'queued'; data: AnalysisRequestJob; trigger?: PipelineTriggerResult }
  | { ok: true; result: 'existing'; data: AnalysisRequestJob }
  | {
      ok: true;
      result: 'fresh';
      data: {
        runId: string | null;
        appStoreId: string;
        country: string;
        publishedAt: string;
        nextAllowedAt: string;
      };
    };
