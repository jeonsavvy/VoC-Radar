const batches = $input.all().map((item) => item.json || {});
if (batches.length === 0) return [];

const failed = batches.find((item) => (item.ID || '').toString().startsWith('PARSE_ERROR_CLUSTER_'));
if (failed) return [{ json: failed }];

const first = batches[0] || {};
const reviewItems = batches.flatMap((batch) => (Array.isArray(batch.reviewItems) ? batch.reviewItems : []));
const extractions = batches.flatMap((batch) =>
  Array.isArray(batch.result?.extractions) ? batch.result.extractions : [],
);
const severityRank = { low: 1, medium: 2, high: 3 };
const merged = new Map();

const errorItem = (message) => [
  {
    json: {
      ID: `PARSE_ERROR_CLUSTER_MERGE_${Date.now()}`,
      긴급도: 'ERROR',
      유형: '파싱실패',
      요약: message,
      원본: '',
      runId: first.runId,
      jobId: first.jobId,
      appStoreId: reviewItems[0]?.appStoreId,
      country: reviewItems[0]?.country,
    },
  },
];

try {
  for (const batch of batches) {
    for (const cluster of batch.result?.clusters || []) {
      const existingClusterId = (cluster.existingClusterId || '').toString().trim() || null;
      const identity = existingClusterId ? `id:${existingClusterId}` : `key:${cluster.canonicalKey}`;
      const current = merged.get(identity);

      if (!current) {
        merged.set(identity, {
          ...cluster,
          existingClusterId,
          reviewIds: [...cluster.reviewIds],
          representativeReviewIds: [...(cluster.representativeReviewIds || [])],
        });
        continue;
      }

      if (current.canonicalKey !== cluster.canonicalKey) {
        throw new Error('existing cluster canonicalKey mismatch');
      }
      current.reviewIds = [...new Set([...current.reviewIds, ...cluster.reviewIds])];
      current.representativeReviewIds = [
        ...new Set([...(current.representativeReviewIds || []), ...(cluster.representativeReviewIds || [])]),
      ]
        .filter((id) => current.reviewIds.includes(id))
        .slice(0, 3);
      if ((severityRank[cluster.severity] || 0) > (severityRank[current.severity] || 0)) {
        current.severity = cluster.severity;
      }
    }
  }

  const clusters = [...merged.values()];
  const canonicalKeys = new Set();
  const expectedIds = reviewItems.map((item) => (item.ID || '').toString());
  const expected = new Set(expectedIds);
  const assigned = new Set();

  if (expected.size !== expectedIds.length) throw new Error('duplicate reviewId across cluster batches');
  if (extractions.length !== expectedIds.length) throw new Error('merged extraction count mismatch');

  for (const cluster of clusters) {
    if (canonicalKeys.has(cluster.canonicalKey)) throw new Error('duplicate canonicalKey after batch merge');
    canonicalKeys.add(cluster.canonicalKey);
    for (const id of cluster.reviewIds || []) {
      if (!expected.has(id)) throw new Error(`unknown merged reviewId: ${id}`);
      if (assigned.has(id)) throw new Error(`duplicate merged assignment: ${id}`);
      assigned.add(id);
    }
    if ((cluster.representativeReviewIds || []).some((id) => !cluster.reviewIds.includes(id))) {
      throw new Error('merged representative review must be a member');
    }
  }

  const missing = expectedIds.filter((id) => !assigned.has(id));
  if (missing.length) throw new Error(`unassigned merged reviewIds: ${missing.join(',')}`);

  const { clusterBatchIndex, clusterBatchCount, clusterBatchLimit, ...base } = first;
  return [
    {
      json: {
        ...base,
        reviewItems,
        inputReviewIds: expectedIds,
        result: { extractions, clusters },
        validation: {
          passed: true,
          inputReviewCount: expectedIds.length,
          extractionCount: extractions.length,
          assignedReviewCount: assigned.size,
          clusterCount: clusters.length,
          clusterBatchCount: batches.length,
        },
      },
    },
  ];
} catch (error) {
  return errorItem(error.message || 'cluster batch merge failed');
}
