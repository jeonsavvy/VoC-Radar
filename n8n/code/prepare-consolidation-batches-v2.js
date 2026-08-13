const context = $input.first().json || {};
const errorItem = (message) => [{ json: {
  ID: 'PARSE_ERROR_CLUSTER_CONSOLIDATION_INPUT_' + Date.now(),
  긴급도: 'ERROR', 유형: '파싱실패', 요약: message, 원본: '',
  runId: context.runId, jobId: context.jobId, claimToken: context.claimToken,
  appStoreId: context.reviewItems?.[0]?.appStoreId,
  country: context.reviewItems?.[0]?.country,
} }];

if ((context.ID || '').toString().startsWith('PARSE_ERROR_CLUSTER_')) {
  return [{ json: context }];
}

try {
  const sourceClusters = Array.isArray(context.result?.clusters) ? context.result.clusters : [];
  if (sourceClusters.length === 0) throw new Error('cluster candidates must not be empty');
  if (sourceClusters.length > 10000) {
    throw new Error('cluster candidate count exceeds 10000');
  }

  const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
  const severities = ['high', 'medium', 'low'];
  const candidates = sourceClusters.map((cluster, index) => {
    const canonicalKey = (cluster.canonicalKey || '').toString().trim();
    const title = (cluster.title || '').toString().trim();
    const summary = (cluster.summary || '').toString().trim();
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) throw new Error('invalid candidate canonicalKey');
    if (!title || title.length > 120) throw new Error('candidate title length is invalid');
    if (!summary || summary.length > 400) throw new Error('candidate summary length is invalid');
    if (!categories.includes(cluster.category)) throw new Error('invalid candidate category');
    if (!severities.includes(cluster.severity)) throw new Error('invalid candidate severity');
    return {
      candidateId: 'candidate-' + index,
      existingClusterId: cluster.existingClusterId || null,
      canonicalKey,
      title,
      category: cluster.category,
      severity: cluster.severity,
      summary,
      reviewCount: Array.isArray(cluster.reviewIds) ? cluster.reviewIds.length : 0,
    };
  });
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  candidates.sort((left, right) =>
    compareText(left.category, right.category) ||
    compareText(left.canonicalKey, right.canonicalKey) ||
    compareText(left.candidateId, right.candidateId)
  );

  const promptPrefix = '# Candidate issue clusters\n';
  const promptSuffix = '\n\n# Task\nGroup every candidateId in this batch exactly once. Merge candidates only when they describe the same underlying product problem; keep materially different problems separate. existingClusterId must be null unless copied from a candidate in the same group. canonicalKey must be copied exactly from one candidate in the same group; when retaining an existingClusterId, copy that candidate canonicalKey.\n\nReturn ONLY {"groups":[{"candidateIds":["candidate-0"],"existingClusterId":"source uuid or null","canonicalKey":"exact source key","title":"short Korean noun phrase","category":"버그 및 성능|계정 및 결제|기능 및 사용성|콘텐츠 및 운영 정책|긍정 리뷰 및 기타","severity":"high|medium|low","summary":"evidence-bound Korean summary","actionHint":"one concrete next step"}]}. Do not output review IDs, confidence, markdown, or prose.';
  const utf8Length = (value) => new TextEncoder().encode(value).length;
  const renderPrompt = (batch) => promptPrefix + JSON.stringify(batch) + promptSuffix;
  const batches = [];
  let current = [];

  for (const candidate of candidates) {
    const next = [...current, candidate];
    const nextPrompt = renderPrompt(next);
    if (next.length > 48 || utf8Length(nextPrompt) > 65536) {
      if (current.length === 0) throw new Error('one candidate exceeds the consolidation prompt budget');
      batches.push(current);
      current = [candidate];
      if (utf8Length(renderPrompt(current)) > 65536) {
        throw new Error('one candidate exceeds the consolidation prompt budget');
      }
    } else {
      current = next;
    }
  }
  if (current.length > 0) batches.push(current);

  return batches.map((batch, batchIndex) => {
    const prompt = renderPrompt(batch);
    const promptBytes = utf8Length(prompt);
    if (batch.length > 48 || promptBytes > 65536) {
      throw new Error('consolidation batch budget was exceeded');
    }
    return { json: {
      runId: context.runId, jobId: context.jobId, claimToken: context.claimToken,
      consolidationBatchIndex: batchIndex,
      consolidationBatchCount: batches.length,
      candidateCount: batch.length,
      promptBytes,
      candidates: batch,
      prompt,
    } };
  });
} catch (error) {
  return errorItem(error.message || 'consolidation input validation failed');
}
