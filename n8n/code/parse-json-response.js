const llmItems = $input.all();
const contextItems = $('Ensure New Reviews').all();
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const priorities = ['Critical', 'High', 'Normal'];
const parseJson = (value) => {
  const raw = (value || '').toString().replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
  return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
};
const errorItem = (context, message, raw, index) => ({ json: {
  ID: 'PARSE_ERROR_' + Date.now() + '_' + index,
  긴급도: 'ERROR', 유형: '파싱실패', 요약: message, 원본: (raw || '').toString().slice(0, 4000),
  작성자: 'system', 작성일시: new Date().toISOString(), 별점: '',
  runId: context.runId || null, jobId: context.jobId || null, claimToken: context.claimToken || null,
  appStoreId: context.appStoreId || null, country: context.country || null, appName: context.appName || ''
} });
const output = [];
if (llmItems.length !== contextItems.length) {
  const context = (contextItems[0] || { json: {} }).json || {};
  const raw = llmItems.map((item) => item?.json?.text || item?.json?.output || '').join('\n--- batch ---\n');
  return [errorItem(
    context,
    'extraction batch count mismatch: expected ' + contextItems.length + ', received ' + llmItems.length,
    raw,
    'batch_count',
  )];
}
for (let batchIndex = 0; batchIndex < llmItems.length; batchIndex += 1) {
  const llm = llmItems[batchIndex]?.json || {};
  const raw = llm.text || llm.output || '';
  const context = (contextItems[batchIndex] || contextItems[0] || { json: {} }).json || {};
  const source = Array.isArray(context.reviews) ? context.reviews : [];
  try {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed) || parsed.length !== source.length) throw new Error('extraction count mismatch');
    const byId = new Map(parsed.map((item) => [(item.reviewId || '').toString().trim(), item]));
    if (byId.size !== source.length) throw new Error('duplicate or missing extraction reviewId');
    for (const review of source) {
      const reviewId = (review.reviewId || '').toString().trim();
      const item = byId.get(reviewId);
      if (!reviewId || !item) throw new Error('unknown or missing extraction reviewId');
      if (!categories.includes(item.category)) throw new Error('invalid extraction category: ' + item.category);
      if (!priorities.includes(item.priority)) throw new Error('invalid extraction priority: ' + item.priority);
      const summary = (item.summary || '').toString().trim();
      if (!summary) throw new Error('extraction summary is required');
      output.push({ json: {
        ID: reviewId, id: reviewId, priority: item.priority, category: item.category, summary: summary.slice(0, 240),
        author: (review.author || '').toString(), date: (review.reviewedAt || '').toString(),
        rating: (review.rating ?? '').toString(), content: (review.content || '').toString(),
        긴급도: item.priority, 유형: item.category, 요약: summary.slice(0, 240),
        작성자: (review.author || '').toString(), 작성일시: (review.reviewedAt || '').toString(),
        별점: (review.rating ?? '').toString(), 원본: (review.content || '').toString(),
        runId: context.runId || null, jobId: context.jobId || null, claimToken: context.claimToken || null,
        appStoreId: context.appStoreId || null, country: context.country || null, appName: context.appName || ''
      } });
    }
  } catch (error) {
    output.push(errorItem(context, error.message || 'extraction parse failed', raw, batchIndex));
  }
}
return output;
