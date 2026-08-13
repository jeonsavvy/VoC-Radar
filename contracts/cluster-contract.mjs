export const CLUSTER_CATEGORIES = Object.freeze([
  '버그 및 성능',
  '계정 및 결제',
  '기능 및 사용성',
  '콘텐츠 및 운영 정책',
  '긍정 리뷰 및 기타',
]);

export const CLUSTER_SEVERITIES = Object.freeze(['high', 'medium', 'low']);

export const CLUSTER_CONTRACT_LIMITS = Object.freeze({
  inputReviewCount: 10_000,
  extractionSummary: 240,
  clusterTitle: 100,
  clusterSummary: 400,
  clusterActionHint: 300,
  representativeReviewIds: 3,
});

export const CATEGORIES = CLUSTER_CATEGORIES;
export const SEVERITIES = CLUSTER_SEVERITIES;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const requiredText = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
};

export function validateClusterContract(inputReviewIds, candidate) {
  if (
    !Array.isArray(inputReviewIds)
    || inputReviewIds.length === 0
    || inputReviewIds.length > CLUSTER_CONTRACT_LIMITS.inputReviewCount
  ) {
    throw new Error(
      `inputReviewIds must contain between 1 and ${CLUSTER_CONTRACT_LIMITS.inputReviewCount} review ids`,
    );
  }
  if (!isRecord(candidate)) throw new Error('candidate must be an object');

  const expected = inputReviewIds.map((id) => requiredText(id, 'inputReviewIds[]'));
  if (new Set(expected).size !== expected.length) throw new Error('inputReviewIds contains duplicates');

  const extractions = Array.isArray(candidate.extractions) ? candidate.extractions : [];
  const clusters = Array.isArray(candidate.clusters) ? candidate.clusters : [];
  if (extractions.length !== expected.length) throw new Error('every review must have one extraction');
  if (clusters.length === 0) throw new Error('clusters must not be empty');

  const expectedSet = new Set(expected);
  const extractionIds = new Set();
  const normalizedExtractions = extractions.map((item, index) => {
    if (!isRecord(item)) throw new Error(`extractions[${index}] must be an object`);
    const reviewId = requiredText(item.reviewId, `extractions[${index}].reviewId`);
    if (!expectedSet.has(reviewId)) throw new Error(`unknown extraction reviewId: ${reviewId}`);
    if (extractionIds.has(reviewId)) throw new Error(`duplicate extraction reviewId: ${reviewId}`);
    extractionIds.add(reviewId);
    const category = requiredText(item.category, `extractions[${index}].category`);
    if (!CLUSTER_CATEGORIES.includes(category)) throw new Error(`invalid category: ${category}`);
    return {
      reviewId,
      category,
      summary: requiredText(item.summary, `extractions[${index}].summary`)
        .slice(0, CLUSTER_CONTRACT_LIMITS.extractionSummary),
    };
  });

  const assigned = new Set();
  const canonicalKeys = new Set();
  const normalizedClusters = clusters.map((item, index) => {
    if (!isRecord(item)) throw new Error(`clusters[${index}] must be an object`);
    const canonicalKey = requiredText(item.canonicalKey, `clusters[${index}].canonicalKey`).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) {
      throw new Error(`invalid canonicalKey: ${canonicalKey}`);
    }
    if (canonicalKeys.has(canonicalKey)) throw new Error(`duplicate canonicalKey: ${canonicalKey}`);
    canonicalKeys.add(canonicalKey);

    const category = requiredText(item.category, `clusters[${index}].category`);
    if (!CLUSTER_CATEGORIES.includes(category)) throw new Error(`invalid category: ${category}`);
    const severity = requiredText(item.severity, `clusters[${index}].severity`).toLowerCase();
    if (!CLUSTER_SEVERITIES.includes(severity)) throw new Error(`invalid severity: ${severity}`);

    const reviewIds = Array.isArray(item.reviewIds) ? item.reviewIds : [];
    if (reviewIds.length === 0) throw new Error(`clusters[${index}].reviewIds must not be empty`);
    const normalizedReviewIds = reviewIds.map((value) =>
      requiredText(value, `clusters[${index}].reviewIds[]`));
    for (const reviewId of normalizedReviewIds) {
      if (!expectedSet.has(reviewId)) throw new Error(`unknown cluster reviewId: ${reviewId}`);
      if (assigned.has(reviewId)) throw new Error(`review assigned more than once: ${reviewId}`);
      assigned.add(reviewId);
    }

    const representativeReviewIds = (Array.isArray(item.representativeReviewIds)
      ? item.representativeReviewIds.map((value) => requiredText(value, 'representativeReviewIds[]'))
      : normalizedReviewIds
    ).slice(0, CLUSTER_CONTRACT_LIMITS.representativeReviewIds);
    if (representativeReviewIds.some((id) => !normalizedReviewIds.includes(id))) {
      throw new Error(`representative review must belong to cluster: ${canonicalKey}`);
    }

    return {
      existingClusterId:
        typeof item.existingClusterId === 'string' && item.existingClusterId.trim()
          ? item.existingClusterId.trim()
          : null,
      canonicalKey,
      title: requiredText(item.title, `clusters[${index}].title`)
        .slice(0, CLUSTER_CONTRACT_LIMITS.clusterTitle),
      category,
      severity,
      summary: requiredText(item.summary, `clusters[${index}].summary`)
        .slice(0, CLUSTER_CONTRACT_LIMITS.clusterSummary),
      actionHint:
        typeof item.actionHint === 'string' && item.actionHint.trim()
          ? item.actionHint.trim().slice(0, CLUSTER_CONTRACT_LIMITS.clusterActionHint)
          : null,
      reviewIds: normalizedReviewIds,
      representativeReviewIds,
    };
  });

  const missing = expected.filter((id) => !assigned.has(id));
  if (missing.length) throw new Error(`unassigned reviewIds: ${missing.join(', ')}`);

  return {
    extractions: normalizedExtractions,
    clusters: normalizedClusters,
    validation: {
      passed: true,
      inputReviewCount: expected.length,
      extractionCount: normalizedExtractions.length,
      assignedReviewCount: assigned.size,
      clusterCount: normalizedClusters.length,
    },
  };
}
