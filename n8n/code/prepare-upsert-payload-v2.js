const context = $input.first().json || {};
const allReviews = Array.isArray(context.reviewItems) ? context.reviewItems : [];
const reviewsInput = allReviews.filter((item) => item.isExisting !== true);
if (!reviewsInput.length || !allReviews.length) return [];
const first = reviewsInput[0];
const clusters = context.result?.clusters || [];
const runId = (context.runId || '').toString().trim();
const jobId = (context.jobId || '').toString().trim() || null;
const claimToken = (context.claimToken || '').toString().trim() || null;
if (!runId || !jobId || !claimToken) throw new Error('upsert context is incomplete');
const appStoreId = (first.appStoreId || '').toString().trim();
const country = (first.country || 'kr').toString().toLowerCase();
const modelVersion = (($env.VOC_MODEL_VERSION || 'gemini-3-flash-preview').toString().trim().replace(/^models\//, '') || 'gemini-3-flash-preview');
const reviews = reviewsInput.map((item) => {
  const id = (item.ID || '').toString();
  const cluster = clusters.find((entry) => Array.isArray(entry.reviewIds) && entry.reviewIds.includes(id));
  return {
    reviewId: id, rating: Number(item.rating) || 0, author: item.author || '', content: item.content || '', reviewedAt: item.date,
    priority: item.priority, category: item.category, issueLabel: cluster?.title || item.category,
    reasonSummary: cluster?.summary || item.summary, actionHint: cluster?.actionHint || '', summary: item.summary,
    modelVersion
  };
});
return [{ json: { runId, jobId, claimToken, inputReviewIds: context.inputReviewIds, clusterResult: context.result, modelVersion,
  comparisonEligible: context.forceReanalysis !== true, payload: {
  runId, jobId, claimToken, source: 'n8n', app: { appStoreId, country, appName: first.appName || '' }, reviews
} } }];
