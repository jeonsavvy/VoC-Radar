const contexts = $('Prepare Consolidation Batches').all().map((item) => item.json || {});
const llmItems = $input.all();
const sourceContext = $('Merge Cluster Batches').first().json || {};
const rawResponses = llmItems.map((item) => (item.json?.text || item.json?.output || '').toString());
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const severities = ['high', 'medium', 'low'];
const errorItem = (message, raw = '') => [{ json: {
  ID: 'PARSE_ERROR_CLUSTER_CONSOLIDATION_' + Date.now(),
  긴급도: 'ERROR', 유형: '파싱실패', 요약: message, 원본: raw.slice(0, 4000),
  runId: sourceContext.runId, jobId: sourceContext.jobId, claimToken: sourceContext.claimToken,
  appStoreId: sourceContext.reviewItems?.[0]?.appStoreId,
  country: sourceContext.reviewItems?.[0]?.country,
} }];

try {
  if (llmItems.length !== contexts.length) {
    throw new Error('consolidation batch count mismatch: expected ' + contexts.length + ', received ' + llmItems.length);
  }
  const sourceClusters = Array.isArray(sourceContext.result?.clusters) ? sourceContext.result.clusters : [];
  const sourceById = new Map(sourceClusters.map((cluster, index) => ['candidate-' + index, cluster]));
  const expectedCandidateIds = contexts.flatMap((context) =>
    (Array.isArray(context.candidates) ? context.candidates : []).map((candidate) => candidate.candidateId)
  );
  if (expectedCandidateIds.length !== sourceClusters.length || new Set(expectedCandidateIds).size !== sourceClusters.length) {
    throw new Error('consolidation input candidate partition is incomplete');
  }
  if (expectedCandidateIds.some((candidateId) => !sourceById.has(candidateId))) {
    throw new Error('consolidation input contains an unknown candidateId');
  }

  const assignedCandidates = new Set();
  const canonicalKeys = new Set();
  const clusters = [];

  for (let batchIndex = 0; batchIndex < contexts.length; batchIndex += 1) {
    const context = contexts[batchIndex] || {};
    const raw = rawResponses[batchIndex] || '';
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    if (groups.length === 0) throw new Error('consolidation groups must not be empty');

    const batchCandidateIds = (Array.isArray(context.candidates) ? context.candidates : [])
      .map((candidate) => candidate.candidateId);
    const batchExpected = new Set(batchCandidateIds);
    const batchAssigned = new Set();

    for (const group of groups) {
      if (!Array.isArray(group.candidateIds) || group.candidateIds.length === 0) {
        throw new Error('consolidation candidateIds required');
      }
      const groupCandidateIds = group.candidateIds.map((value) => (value || '').toString().trim());
      const sourceGroup = [];
      for (const candidateId of groupCandidateIds) {
        if (!batchExpected.has(candidateId)) throw new Error('unknown or cross-batch consolidation candidateId: ' + candidateId);
        if (batchAssigned.has(candidateId) || assignedCandidates.has(candidateId)) {
          throw new Error('duplicate consolidation candidate assignment: ' + candidateId);
        }
        batchAssigned.add(candidateId);
        assignedCandidates.add(candidateId);
        sourceGroup.push(sourceById.get(candidateId));
      }

      const existingIds = [...new Set(sourceGroup.map((cluster) => cluster.existingClusterId).filter(Boolean))];
      const existingClusterId = (group.existingClusterId || '').toString().trim() || null;
      if (existingIds.length > 0 && !existingIds.includes(existingClusterId)) {
        throw new Error('consolidation must retain one source existingClusterId');
      }
      if (existingIds.length === 0 && existingClusterId) throw new Error('consolidation invented existingClusterId');

      const canonicalKey = (group.canonicalKey || '').toString().trim();
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) throw new Error('invalid consolidated canonicalKey');
      if (!sourceGroup.some((cluster) => cluster.canonicalKey === canonicalKey)) {
        throw new Error('consolidation canonicalKey must come from its source candidates');
      }
      if (existingClusterId) {
        const retained = sourceGroup.find((cluster) => cluster.existingClusterId === existingClusterId);
        if (!retained || retained.canonicalKey !== canonicalKey) {
          throw new Error('consolidation changed retained existing canonicalKey');
        }
      }
      if (canonicalKeys.has(canonicalKey)) throw new Error('duplicate consolidated canonicalKey');
      canonicalKeys.add(canonicalKey);
      if (!categories.includes(group.category)) throw new Error('invalid consolidated category');
      if (!severities.includes(group.severity)) throw new Error('invalid consolidated severity');

      const title = (group.title || '').toString().trim();
      const summary = (group.summary || '').toString().trim();
      const actionHint = (group.actionHint || '').toString().trim();
      if (!title || title.length > 120) throw new Error('consolidated title length is invalid');
      if (!summary || summary.length > 400) throw new Error('consolidated summary length is invalid');
      if (actionHint.length > 240) throw new Error('consolidated actionHint length is invalid');

      const reviewIds = [...new Set(sourceGroup.flatMap((cluster) => cluster.reviewIds || []))];
      const representativeReviewIds = [...new Set(
        sourceGroup.flatMap((cluster) => cluster.representativeReviewIds || [])
      )].filter((reviewId) => reviewIds.includes(reviewId)).slice(0, 3);
      clusters.push({
        existingClusterId, canonicalKey, title, category: group.category, severity: group.severity,
        summary, actionHint, reviewIds, representativeReviewIds,
      });
    }

    const missingBatchCandidates = batchCandidateIds.filter((candidateId) => !batchAssigned.has(candidateId));
    if (missingBatchCandidates.length > 0) {
      throw new Error('unassigned batch candidateIds: ' + missingBatchCandidates.join(','));
    }
  }

  const missingCandidates = expectedCandidateIds.filter((candidateId) => !assignedCandidates.has(candidateId));
  if (missingCandidates.length > 0 || assignedCandidates.size !== sourceClusters.length) {
    throw new Error('not every consolidation candidate was assigned exactly once');
  }

  const inputReviewIds = Array.isArray(sourceContext.inputReviewIds) ? sourceContext.inputReviewIds : [];
  const expectedReviews = new Set(inputReviewIds);
  const assignedReviews = new Set();
  for (const cluster of clusters) {
    for (const reviewId of cluster.reviewIds) {
      if (!expectedReviews.has(reviewId)) throw new Error('unknown consolidated reviewId: ' + reviewId);
      if (assignedReviews.has(reviewId)) throw new Error('duplicate consolidated reviewId: ' + reviewId);
      assignedReviews.add(reviewId);
    }
  }
  const missingReviews = inputReviewIds.filter((reviewId) => !assignedReviews.has(reviewId));
  if (missingReviews.length > 0) throw new Error('unassigned consolidated reviewIds: ' + missingReviews.join(','));

  return [{ json: {
    ...sourceContext,
    result: { extractions: sourceContext.result?.extractions || [], clusters },
    validation: {
      ...(sourceContext.validation || {}), passed: true,
      assignedReviewCount: assignedReviews.size,
      clusterCount: clusters.length,
      candidateClusterCount: sourceClusters.length,
      consolidationBatchCount: contexts.length,
    },
  } }];
} catch (error) {
  return errorItem(error.message || 'cluster consolidation failed', rawResponses.join('\n--- batch ---\n'));
}
