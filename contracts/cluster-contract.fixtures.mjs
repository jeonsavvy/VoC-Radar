const category = '기능 및 사용성';

const normalizedBoundaryCandidate = {
  extractions: ['r1', 'r2', 'r3', 'r4'].map((reviewId) => ({
    reviewId,
    category,
    summary: ` ${'나'.repeat(250)} `,
  })),
  clusters: [{
    existingClusterId: ' existing-1 ',
    canonicalKey: 'EXPORT-REQUEST',
    title: ` ${'다'.repeat(110)} `,
    category,
    severity: 'LOW',
    summary: ` ${'가'.repeat(450)} `,
    actionHint: ` ${'라'.repeat(350)} `,
    reviewIds: ['r1', 'r2', 'r3', 'r4'],
    representativeReviewIds: ['r4', 'r3', 'r2', 'r1'],
  }],
};

const exactAssignmentCandidate = {
  extractions: ['r1', 'r2'].map((reviewId) => ({ reviewId, category, summary: '내보내기가 필요하다.' })),
  clusters: [{
    canonicalKey: 'export-request',
    title: '내보내기 요청',
    category,
    severity: 'medium',
    summary: '내보내기 기능 요청이다.',
    reviewIds: ['r1', 'r2'],
  }],
};

export function createClusterContractFixtures() {
  const duplicateAssignment = structuredClone(exactAssignmentCandidate);
  duplicateAssignment.clusters.push({
    ...duplicateAssignment.clusters[0],
    canonicalKey: 'second-export-request',
    reviewIds: ['r2'],
  });

  const unknownReview = structuredClone(exactAssignmentCandidate);
  unknownReview.clusters[0].reviewIds = ['r1', 'invented-review'];

  const invalidCategory = structuredClone(exactAssignmentCandidate);
  invalidCategory.clusters[0].category = 'invalid-category';

  return [
    {
      name: 'normalizes 401-500 character summaries and four representatives',
      inputReviewIds: ['r1', 'r2', 'r3', 'r4'],
      candidate: structuredClone(normalizedBoundaryCandidate),
      outcome: 'valid',
    },
    {
      name: 'accepts exact one-time assignment',
      inputReviewIds: ['r1', 'r2'],
      candidate: structuredClone(exactAssignmentCandidate),
      outcome: 'valid',
    },
    {
      name: 'rejects an invented review id',
      inputReviewIds: ['r1', 'r2'],
      candidate: unknownReview,
      outcome: 'invalid',
    },
    {
      name: 'rejects assignment of one review to two clusters',
      inputReviewIds: ['r1', 'r2'],
      candidate: duplicateAssignment,
      outcome: 'invalid',
    },
    {
      name: 'rejects an invalid category enum',
      inputReviewIds: ['r1', 'r2'],
      candidate: invalidCategory,
      outcome: 'invalid',
    },
    {
      name: 'rejects more than 10000 input reviews',
      inputReviewIds: Array.from({ length: 10_001 }, (_, index) => `review-${index}`),
      candidate: { extractions: [], clusters: [] },
      outcome: 'invalid',
    },
  ];
}
