const freshReviews = $('Filter Duplicates').all().map((item) => ({ ...(item.json || {}), isExisting: false }));
const runContext = $('Prepare Run Context').first().json || {};
const preflight = $('Filter New Reviews via BFF').first().json?.data || {};
const existingReviews = Array.isArray(preflight.existingExtractions) ? preflight.existingExtractions : [];
const seen = new Set();
const reviews = [...freshReviews, ...existingReviews].filter((item) => {
  const id = (item.ID || item.id || '').toString();
  if (!id || seen.has(id)) return false;
  seen.add(id); return true;
});
if (reviews.length === 0) return [];
const first = freshReviews[0] || reviews[0];
return [{ json: {
  runId: runContext.runId, jobId: runContext.jobId || null, claimToken: runContext.claimToken || null,
  source: runContext.source || '',
  forceReanalysis: runContext.forceReanalysis === true,
  reviewItems: reviews,
  payload: {
    jobId: runContext.jobId,
    claimToken: runContext.claimToken,
    runId: runContext.runId,
    appStoreId: first.appStoreId,
    country: first.country || 'kr'
  }
} }];
