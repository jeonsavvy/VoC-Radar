export const CLUSTER_CATEGORIES: readonly [
  '버그 및 성능',
  '계정 및 결제',
  '기능 및 사용성',
  '콘텐츠 및 운영 정책',
  '긍정 리뷰 및 기타',
];
export const CLUSTER_SEVERITIES: readonly ['high', 'medium', 'low'];
export const CATEGORIES: typeof CLUSTER_CATEGORIES;
export const SEVERITIES: typeof CLUSTER_SEVERITIES;
export const CLUSTER_CONTRACT_LIMITS: Readonly<{
  inputReviewCount: 10_000;
  extractionSummary: 240;
  clusterTitle: 100;
  clusterSummary: 400;
  clusterActionHint: 300;
  representativeReviewIds: 3;
}>;

export type ClusterCategory = (typeof CLUSTER_CATEGORIES)[number];
export type ClusterSeverity = (typeof CLUSTER_SEVERITIES)[number];

export interface ValidatedClusterContract {
  extractions: Array<{ reviewId: string; category: ClusterCategory; summary: string }>;
  clusters: Array<{
    existingClusterId: string | null;
    canonicalKey: string;
    title: string;
    category: ClusterCategory;
    severity: ClusterSeverity;
    summary: string;
    actionHint: string | null;
    reviewIds: string[];
    representativeReviewIds: string[];
  }>;
  validation: {
    passed: true;
    inputReviewCount: number;
    extractionCount: number;
    assignedReviewCount: number;
    clusterCount: number;
  };
}

export function validateClusterContract(
  inputReviewIds: string[],
  candidate: unknown,
): ValidatedClusterContract;
