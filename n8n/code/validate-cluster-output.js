const contexts = $('Prepare Cluster Input').all().map((item) => item.json || {});
const llmItems = $input.all();
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const severities = ['high', 'medium', 'low'];
const output = [];

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
    const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : [];
    if (!clusters.length) throw new Error('clusters must not be empty');

    const inputReviewIds = context.reviewItems.map((item) => (item.ID || '').toString());
    const expected = new Set(inputReviewIds);
    const assigned = new Set();
    const keys = new Set();

    for (const cluster of clusters) {
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test((cluster.canonicalKey || '').toString())) {
        throw new Error('invalid canonicalKey');
      }
      if (keys.has(cluster.canonicalKey)) throw new Error('duplicate canonicalKey');
      keys.add(cluster.canonicalKey);
      if (!categories.includes(cluster.category)) throw new Error('invalid cluster category');
      if (!severities.includes(cluster.severity)) throw new Error('invalid severity');
      if (!(cluster.title || '').toString().trim() || !(cluster.summary || '').toString().trim()) {
        throw new Error('cluster title and summary are required');
      }
      if (!Array.isArray(cluster.reviewIds) || cluster.reviewIds.length === 0) {
        throw new Error('cluster reviewIds required');
      }
      for (const id of cluster.reviewIds) {
        if (!expected.has(id)) throw new Error(`unknown cluster reviewId: ${id}`);
        if (assigned.has(id)) throw new Error(`duplicate cluster assignment: ${id}`);
        assigned.add(id);
      }
      const representatives = Array.isArray(cluster.representativeReviewIds)
        ? cluster.representativeReviewIds
        : cluster.reviewIds.slice(0, 3);
      if (representatives.some((id) => !cluster.reviewIds.includes(id))) {
        throw new Error('representative review must be a member');
      }
      cluster.representativeReviewIds = representatives.slice(0, 3);
    }

    const missing = inputReviewIds.filter((id) => !assigned.has(id));
    if (missing.length) throw new Error(`unassigned reviewIds: ${missing.join(',')}`);

    output.push({
      json: {
        ...context,
        inputReviewIds,
        result: {
          extractions: context.reviewItems.map((item) => ({
            reviewId: item.ID,
            category: item.category,
            summary: item.summary,
          })),
          clusters,
        },
        validation: {
          passed: true,
          inputReviewCount: inputReviewIds.length,
          extractionCount: inputReviewIds.length,
          assignedReviewCount: assigned.size,
          clusterCount: clusters.length,
        },
      },
    });
  } catch (error) {
    output.push(errorItem(error.message || 'cluster validation failed'));
  }
}

return output;
