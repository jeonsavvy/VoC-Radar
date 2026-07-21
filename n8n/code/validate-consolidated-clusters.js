const context = $('Merge Cluster Batches').first().json || {};
const llm = $input.first().json || {};
const raw = (llm.text || llm.output || '').toString();
const candidates = (context.result?.clusters || []).map((cluster, index) => ({
  candidateId: `candidate-${index}`,
  cluster,
}));
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const severities = ['high', 'medium', 'low'];

const errorItem = (message) => [
  {
    json: {
      ID: `PARSE_ERROR_CLUSTER_CONSOLIDATION_${Date.now()}`,
      긴급도: 'ERROR',
      유형: '파싱실패',
      요약: message,
      원본: raw.slice(0, 4000),
      runId: context.runId,
      jobId: context.jobId,
      appStoreId: context.reviewItems?.[0]?.appStoreId,
      country: context.reviewItems?.[0]?.country,
    },
  },
];

try {
  if (candidates.length === 0) throw new Error('cluster candidates must not be empty');
  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  const parsed = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  if (groups.length === 0) throw new Error('consolidation groups must not be empty');

  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate.cluster]));
  const assignedCandidates = new Set();
  const canonicalKeys = new Set();
  const clusters = [];

  for (const group of groups) {
    if (!Array.isArray(group.candidateIds) || group.candidateIds.length === 0) {
      throw new Error('consolidation candidateIds required');
    }
    const sourceClusters = [];
    for (const candidateId of group.candidateIds) {
      if (!byId.has(candidateId)) throw new Error(`unknown consolidation candidateId: ${candidateId}`);
      if (assignedCandidates.has(candidateId)) {
        throw new Error(`duplicate consolidation candidate assignment: ${candidateId}`);
      }
      assignedCandidates.add(candidateId);
      sourceClusters.push(byId.get(candidateId));
    }

    const existingIds = [
      ...new Set(sourceClusters.map((cluster) => cluster.existingClusterId).filter(Boolean)),
    ];
    const existingClusterId = (group.existingClusterId || '').toString().trim() || null;
    if (existingIds.length > 0 && !existingIds.includes(existingClusterId)) {
      throw new Error('consolidation must retain one source existingClusterId');
    }
    if (existingIds.length === 0 && existingClusterId) {
      throw new Error('consolidation invented existingClusterId');
    }

    const canonicalKey = (group.canonicalKey || '').toString().trim();
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) throw new Error('invalid consolidated canonicalKey');
    if (canonicalKeys.has(canonicalKey)) throw new Error('duplicate consolidated canonicalKey');
    canonicalKeys.add(canonicalKey);
    if (existingClusterId) {
      const retained = sourceClusters.find((cluster) => cluster.existingClusterId === existingClusterId);
      if (!retained || retained.canonicalKey !== canonicalKey) {
        throw new Error('consolidation changed retained existing canonicalKey');
      }
    }
    if (!categories.includes(group.category)) throw new Error('invalid consolidated category');
    if (!severities.includes(group.severity)) throw new Error('invalid consolidated severity');
    if (!(group.title || '').toString().trim() || !(group.summary || '').toString().trim()) {
      throw new Error('consolidated title and summary are required');
    }

    const reviewIds = [...new Set(sourceClusters.flatMap((cluster) => cluster.reviewIds || []))];
    const representativeReviewIds = [
      ...new Set(sourceClusters.flatMap((cluster) => cluster.representativeReviewIds || [])),
    ]
      .filter((reviewId) => reviewIds.includes(reviewId))
      .slice(0, 3);
    clusters.push({
      existingClusterId,
      canonicalKey,
      title: group.title.toString().trim(),
      category: group.category,
      severity: group.severity,
      summary: group.summary.toString().trim(),
      actionHint: (group.actionHint || '').toString().trim(),
      reviewIds,
      representativeReviewIds,
    });
  }

  const missingCandidates = candidates
    .map((candidate) => candidate.candidateId)
    .filter((candidateId) => !assignedCandidates.has(candidateId));
  if (missingCandidates.length) {
    throw new Error(`unassigned consolidation candidateIds: ${missingCandidates.join(',')}`);
  }

  const inputReviewIds = context.inputReviewIds || [];
  const expected = new Set(inputReviewIds);
  const assignedReviews = new Set();
  for (const cluster of clusters) {
    for (const reviewId of cluster.reviewIds) {
      if (!expected.has(reviewId)) throw new Error(`unknown consolidated reviewId: ${reviewId}`);
      if (assignedReviews.has(reviewId)) throw new Error(`duplicate consolidated reviewId: ${reviewId}`);
      assignedReviews.add(reviewId);
    }
  }
  const missingReviews = inputReviewIds.filter((reviewId) => !assignedReviews.has(reviewId));
  if (missingReviews.length) throw new Error(`unassigned consolidated reviewIds: ${missingReviews.join(',')}`);

  return [
    {
      json: {
        ...context,
        result: { extractions: context.result.extractions, clusters },
        validation: {
          ...context.validation,
          passed: true,
          assignedReviewCount: assignedReviews.size,
          clusterCount: clusters.length,
          candidateClusterCount: candidates.length,
        },
      },
    },
  ];
} catch (error) {
  return errorItem(error.message || 'cluster consolidation failed');
}
