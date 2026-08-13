const normalizeValue = (value) => (value ?? '').toString().trim();

const context = (() => {
  try {
    return $('Prepare Run Context').first().json || {};
  } catch {
    return {};
  }
})();

const currentItems = $input.all();
if (!Array.isArray(currentItems) || currentItems.length === 0) {
  return [];
}

const seenCurrentIds = new Set();
const output = [];

for (const item of currentItems) {
  const row = item.json || {};
  const id = normalizeValue(row.id || row.ID);

  if (!id || seenCurrentIds.has(id)) {
    continue;
  }

  seenCurrentIds.add(id);

  const priority = row.priority || row.긴급도 || '';
  const category = row.category || row.유형 || '';
  const issueLabel = row.issueLabel || row.문제 || '';
  const reasonSummary = row.reasonSummary || row.원인 || '';
  const actionHint = row.actionHint || row.액션 || '';
  const summary = row.summary || row.요약 || '';
  const content = row.content || row.원본 || '';
  const rating = row.rating || row.별점 || '';
  const author = row.author || row.작성자 || '';
  const date = row.date || row.작성일시 || '';

  output.push({
    json: {
      ID: id,
      긴급도: priority,
      유형: category,
      문제: issueLabel,
      원인: reasonSummary,
      액션: actionHint,
      요약: summary,
      원본: content,
      별점: rating,
      작성자: author,
      작성일시: date,
      priority,
      category,
      issueLabel,
      reasonSummary,
      actionHint,
      summary,
      content,
      rating,
      author,
      date,
      runId: row.runId || context.runId || null,
      jobId: row.jobId || context.jobId || null,
      claimToken: row.claimToken || context.claimToken || null,
      appStoreId: row.appStoreId || context.appStoreId || null,
      country: row.country || context.country || null,
      appName: row.appName || context.appName || null,
    }
  });
}

return output;
