const contexts = $('Prepare Cluster Input').all().map((item) => item.json || {});
const llmItems = $input.all();
const categories = __CLUSTER_CATEGORIES__;
const severities = __CLUSTER_SEVERITIES__;
const limits = __CLUSTER_CONTRACT_LIMITS__;
const output = [];

if (llmItems.length !== contexts.length) {
  const context = contexts[0] || {};
  return [{ json: {
    ID: 'PARSE_ERROR_CLUSTER_CARDINALITY_' + Date.now(),
    긴급도: 'ERROR',
    유형: '파싱실패',
    요약: 'cluster batch count mismatch: expected ' + contexts.length + ', received ' + llmItems.length,
    원본: '',
    runId: context.runId,
    jobId: context.jobId,
    claimToken: context.claimToken,
    appStoreId: context.reviewItems?.[0]?.appStoreId,
    country: context.reviewItems?.[0]?.country,
  } }];
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredText = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(field + ' is required');
  return normalized;
};

const validateContract = (inputReviewIds, candidate) => {
  if (!Array.isArray(inputReviewIds) || inputReviewIds.length === 0 || inputReviewIds.length > limits.inputReviewCount) {
    throw new Error('inputReviewIds must contain between 1 and ' + limits.inputReviewCount + ' review ids');
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
    if (!isRecord(item)) throw new Error('extractions[' + index + '] must be an object');
    const reviewId = requiredText(item.reviewId, 'extractions[' + index + '].reviewId');
    if (!expectedSet.has(reviewId)) throw new Error('unknown extraction reviewId: ' + reviewId);
    if (extractionIds.has(reviewId)) throw new Error('duplicate extraction reviewId: ' + reviewId);
    extractionIds.add(reviewId);
    const category = requiredText(item.category, 'extractions[' + index + '].category');
    if (!categories.includes(category)) throw new Error('invalid category: ' + category);
    return {
      reviewId,
      category,
      summary: requiredText(item.summary, 'extractions[' + index + '].summary').slice(0, limits.extractionSummary),
    };
  });

  const assigned = new Set();
  const canonicalKeys = new Set();
  const normalizedClusters = clusters.map((item, index) => {
    if (!isRecord(item)) throw new Error('clusters[' + index + '] must be an object');
    const canonicalKey = requiredText(item.canonicalKey, 'clusters[' + index + '].canonicalKey').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) throw new Error('invalid canonicalKey: ' + canonicalKey);
    if (canonicalKeys.has(canonicalKey)) throw new Error('duplicate canonicalKey: ' + canonicalKey);
    canonicalKeys.add(canonicalKey);

    const category = requiredText(item.category, 'clusters[' + index + '].category');
    if (!categories.includes(category)) throw new Error('invalid category: ' + category);
    const severity = requiredText(item.severity, 'clusters[' + index + '].severity').toLowerCase();
    if (!severities.includes(severity)) throw new Error('invalid severity: ' + severity);

    const reviewIds = Array.isArray(item.reviewIds) ? item.reviewIds : [];
    if (reviewIds.length === 0) throw new Error('clusters[' + index + '].reviewIds must not be empty');
    const normalizedReviewIds = reviewIds.map((value) => requiredText(value, 'clusters[' + index + '].reviewIds[]'));
    for (const reviewId of normalizedReviewIds) {
      if (!expectedSet.has(reviewId)) throw new Error('unknown cluster reviewId: ' + reviewId);
      if (assigned.has(reviewId)) throw new Error('review assigned more than once: ' + reviewId);
      assigned.add(reviewId);
    }

    const representativeReviewIds = (Array.isArray(item.representativeReviewIds)
      ? item.representativeReviewIds.map((value) => requiredText(value, 'representativeReviewIds[]'))
      : normalizedReviewIds
    ).slice(0, limits.representativeReviewIds);
    if (representativeReviewIds.some((id) => !normalizedReviewIds.includes(id))) {
      throw new Error('representative review must belong to cluster: ' + canonicalKey);
    }

    return {
      existingClusterId: typeof item.existingClusterId === 'string' && item.existingClusterId.trim()
        ? item.existingClusterId.trim()
        : null,
      canonicalKey,
      title: requiredText(item.title, 'clusters[' + index + '].title').slice(0, limits.clusterTitle),
      category,
      severity,
      summary: requiredText(item.summary, 'clusters[' + index + '].summary').slice(0, limits.clusterSummary),
      actionHint: typeof item.actionHint === 'string' && item.actionHint.trim()
        ? item.actionHint.trim().slice(0, limits.clusterActionHint)
        : null,
      reviewIds: normalizedReviewIds,
      representativeReviewIds,
    };
  });

  const missing = expected.filter((id) => !assigned.has(id));
  if (missing.length) throw new Error('unassigned reviewIds: ' + missing.join(', '));
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
};

for (let batchIndex = 0; batchIndex < contexts.length; batchIndex += 1) {
  const context = contexts[batchIndex] || {};
  const llm = llmItems[batchIndex]?.json || {};
  const raw = (llm.text || llm.output || '').toString();
  const errorItem = (message) => ({
    json: {
      ID: `PARSE_ERROR_CLUSTER_${Date.now()}_${batchIndex}`,
      긴급도: 'ERROR',
      유형: '파싱실패',
      요약: message,
      원본: raw.slice(0, 4000),
      runId: context.runId,
      jobId: context.jobId,
      claimToken: context.claimToken,
      appStoreId: context.reviewItems?.[0]?.appStoreId,
      country: context.reviewItems?.[0]?.country,
      clusterBatchIndex: batchIndex,
    },
  });

  try {
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
    const inputReviewIds = context.reviewItems.map((item) => (item.ID || '').toString());
    const result = validateContract(inputReviewIds, {
      extractions: context.reviewItems.map((item) => ({
        reviewId: (item.ID || '').toString(),
        category: item.category,
        summary: item.summary,
      })),
      clusters: parsed.clusters,
    });
    output.push({ json: { ...context, inputReviewIds, result, validation: result.validation } });
  } catch (error) {
    output.push(errorItem(error.message || 'cluster validation failed'));
  }
}

return output;
