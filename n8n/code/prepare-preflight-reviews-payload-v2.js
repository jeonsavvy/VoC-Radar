const context = $('Prepare Run Context').first().json || {};
const appStoreId = (context.appStoreId || '').toString().trim();
const country = (context.country || 'kr').toString().trim().toLowerCase();
const runId = (context.runId || '').toString().trim();
const jobId = (context.jobId || '').toString().trim();
const claimToken = (context.claimToken || '').toString().trim();

if (!appStoreId || !runId || !jobId || !claimToken) {
  throw new Error('preflight context is incomplete');
}

const responseData = $input.first().json?.data || {};
if (responseData.complete !== true || responseData.truncated === true) {
  throw new Error('review collection did not prove the requested window complete');
}
const inputReviews = Array.isArray(responseData.reviews) ? responseData.reviews : [];
const seen = new Set();
const reviews = inputReviews
  .map((review) => ({
    reviewId: (review.reviewId || '').toString().trim(),
    author: (review.author || '').toString().trim() || 'unknown',
    reviewedAt: (review.reviewedAt || new Date().toISOString()).toString(),
    rating: Number((review.rating || '0').toString().trim()) || 0,
    content: (review.content || '').toString().trim(),
  }))
  .filter((review) => {
    if (!review.reviewId || review.rating <= 0 || seen.has(review.reviewId)) return false;
    seen.add(review.reviewId);
    return true;
  });

return [{ json: {
  runId,
  jobId,
  claimToken,
  payload: {
    appStoreId,
    country,
    runId,
    jobId,
    claimToken,
    reviews,
    forceReanalysis: context.forceReanalysis === true,
  },
} }];
