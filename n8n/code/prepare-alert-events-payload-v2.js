const inputItems = $input.all();
if (!Array.isArray(inputItems) || inputItems.length === 0) return [];

const context = $('Prepare Run Context').first().json || {};
const first = inputItems[0].json || {};
const appStoreId = (first.appStoreId || context.appStoreId || '').toString().trim();
const country = (first.country || context.country || 'kr').toString().trim().toLowerCase();
const runId = (first.runId || context.runId || '').toString().trim();
const jobId = (first.jobId || context.jobId || '').toString().trim();
const claimToken = (first.claimToken || context.claimToken || '').toString().trim();
if (!appStoreId || !runId || !jobId || !claimToken) {
  throw new Error('alert context is incomplete');
}

const alerts = inputItems.map(({ json = {} }) => {
  const rating = Number((json.rating || json.별점 || '0').toString().trim()) || 0;
  const category = (json.category || json.유형 || '').toString().trim();
  return {
    reviewId: (json.reviewId || json.ID || json.id || '').toString().trim(),
    rating,
    priority: (json.priority || json.긴급도 || '').toString().trim(),
    category,
    summary: (json.summary || json.요약 || '').toString().trim(),
    sentAt: new Date().toISOString(),
  };
}).filter((alert) => alert.reviewId && alert.rating > 0);

return [{ json: {
  runId,
  jobId,
  claimToken,
  payload: { runId, jobId, claimToken, appStoreId, country, alerts },
} }];
