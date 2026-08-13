const context = $('Prepare Run Context').first().json || {};
const data = $json.data || {};
const freshReviews = Array.isArray(data.reviews) ? data.reviews : [];
const existingReviews = Array.isArray(data.existingExtractions) ? data.existingExtractions : [];
const sourceReviews = context.forceReanalysis === true
  ? [...freshReviews, ...existingReviews]
  : freshReviews;
const seen = new Set();
const reviews = sourceReviews.map((review) => ({
  reviewId: (review.reviewId || review.ID || review.id || '').toString().trim(),
  author: (review.author || '').toString(),
  reviewedAt: (review.reviewedAt || review.date || '').toString(),
  rating: Number(review.rating) || 0,
  content: (review.content || '').toString()
})).filter((review) => {
  if (!review.reviewId || seen.has(review.reviewId)) return false;
  seen.add(review.reviewId); return true;
});

if (reviews.length === 0) {
  console.log('No reviews eligible for extraction. Stop this run.');
  return [];
}

const rawBatch = ($env.VOC_LLM_BATCH_LIMIT || '50').toString().trim();
const parsedBatch = Number(rawBatch);
const batchLimit = Number.isFinite(parsedBatch)
  ? Math.min(Math.max(Math.floor(parsedBatch), 1), 50)
  : 50;
const chunks = [];
for (let offset = 0; offset < reviews.length; offset += batchLimit) {
  chunks.push(reviews.slice(offset, offset + batchLimit));
}

return chunks.map((chunkReviews, batchIndex) => ({ json: {
  ...context,
  totalFetched: Number(data.total || 0),
  existingCount: Number(data.existingCount || 0),
  newCount: Number(data.newCount || freshReviews.length),
  batchLimit,
  batchIndex,
  batchCount: chunks.length,
  reviews: chunkReviews
} }));
