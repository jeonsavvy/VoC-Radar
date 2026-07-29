import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflowPath = resolve('n8n/workflow.supabase-only.json');
const workflowSource = await readFile(workflowPath, 'utf8');
const normalizedWorkflowSource = workflowSource.replace(/\r\n/g, '\n');
const workflow = JSON.parse(workflowSource);
const validateClusterOutputSource = await readFile(resolve('n8n/code/validate-cluster-output.js'), 'utf8');
const mergeClusterBatchesCode = await readFile(resolve('n8n/code/merge-cluster-batches.js'), 'utf8');
const validateClusterOutputCode = validateClusterOutputSource.replace(
  'const output = [];',
  `const output = [];
if (llmItems.length !== contexts.length) {
  const context = contexts[0] || {};
  return [{ json: {
    ID: 'PARSE_ERROR_CLUSTER_CARDINALITY_' + Date.now(),
    \uAE34\uAE09\uB3C4: 'ERROR',
    \uC720\uD615: '\uD30C\uC2F1\uC2E4\uD328',
    \uC694\uC57D: 'cluster batch count mismatch: expected ' + contexts.length + ', received ' + llmItems.length,
    \uC6D0\uBCF8: '',
    runId: context.runId,
    jobId: context.jobId,
    claimToken: context.claimToken,
    appStoreId: context.reviewItems?.[0]?.appStoreId,
    country: context.reviewItems?.[0]?.country,
  } }];
}`,
);
const byName = new Map(workflow.nodes.map((node) => [node.name, node]));

const setNode = (node) => {
  const existing = byName.get(node.name);
  if (existing) Object.assign(existing, node);
  else {
    workflow.nodes.push(node);
    byName.set(node.name, node);
  }
};

const removeNodes = (names) => {
  const removed = new Set(names);
  workflow.nodes = workflow.nodes.filter((node) => !removed.has(node.name));
  for (const name of removed) {
    byName.delete(name);
    delete workflow.connections[name];
  }
  for (const connection of Object.values(workflow.connections)) {
    for (const outputs of Object.values(connection || {})) {
      if (!Array.isArray(outputs)) continue;
      for (const output of outputs) {
        if (!Array.isArray(output)) continue;
        for (let index = output.length - 1; index >= 0; index -= 1) {
          if (removed.has(output[index]?.node)) output.splice(index, 1);
        }
      }
    }
  }
};

const directSecretExpression =
  "={{ ($env.PIPELINE_WEBHOOK_SECRET || '').toString().trim() }}";
const modelVersionResolver =
  "(($env.VOC_MODEL_VERSION || 'gemini-3-flash-preview').toString().trim().replace(/^models\\//, '') || 'gemini-3-flash-preview')";
const modelNameExpression = `={{ 'models/' + ${modelVersionResolver} }}`;
// n8n 2.30.8's Gemini chat-model node has no per-request timeout option. Inputs
// stay bounded, and every result is rejected unless the 15-minute claim is still current.
const singleModelCallLeaseContract =
  'n8n 2.30.8 Gemini has no request timeout; one bounded call must finish within the 15-minute claim lease.';
const maxConsolidationCandidates = 48;
const maxConsolidationPromptBytes = 64 * 1024;
const maxCandidateCount = 10_000;
const maxCandidateTitleLength = 120;
const maxCandidateSummaryLength = 400;
const maxCandidateActionLength = 240;
const maxExistingClusterContextRows = 10_000;
const preserveAllExistingClusterThreshold = 100;
const maxSelectedExistingClusters = 160;
const maxExistingClusterContextBytes = 48 * 1024;
const internalHttpTimeouts = new Map([
  ['HTTP Request', 300_000],
  ['Claim Job from BFF', 30_000],
  ['Filter New Reviews via BFF', 80_000],
  ['Fetch Cluster Context', 60_000],
  ['Upsert Reviews to BFF', 100_000],
  ['Upsert Clusters to BFF', 150_000],
  ['Notify Publish to BFF', 60_000],
  ['Send Parse Error to BFF', 30_000],
  ['Send Alert Events to BFF', 30_000],
  ['Renew Extraction Lease', 30_000],
  ['Renew Cluster Lease', 30_000],
  ['Renew Consolidation Lease', 30_000],
]);

const configureInternalHttpNode = (name, idempotencyExpression) => {
  const node = byName.get(name);
  if (!node) throw new Error(`Cannot configure missing HTTP node: ${name}`);

  const headers = node.parameters.headerParameters?.parameters || [];
  node.parameters.sendHeaders = true;
  node.parameters.headerParameters = {
    parameters: [
      ...headers.filter((header) => {
        const headerName = (header.name || '').toString().toLowerCase();
        return !['x-voc-token', 'x-voc-timestamp', 'x-voc-signature', 'x-idempotency-key'].includes(
          headerName,
        );
      }),
      { name: 'x-voc-token', value: directSecretExpression },
      { name: 'x-idempotency-key', value: idempotencyExpression },
    ],
  };
  node.parameters.options ||= {};
  delete node.parameters.options.retryOnFail;
  delete node.parameters.options.maxTries;
  node.retryOnFail = true;
  node.maxTries = 3;
  node.waitBetweenTries = 1000;
  delete node.continueOnFail;
  delete node.onError;
};

workflow.settings ||= {};
workflow.settings.saveDataSuccessExecution = 'none';
workflow.settings.saveDataErrorExecution = 'all';
workflow.settings.saveExecutionProgress = false;
workflow.settings.saveManualExecutions = false;

// Run-context and HTTP-response nodes are singletons. Using `.item` asks n8n
// to resolve paired-item ancestry and can fail when batches are merged; `.first()`
// makes the singleton contract explicit and deterministic.
for (const node of workflow.nodes) {
  if (!node?.parameters?.jsCode) continue;
  node.parameters.jsCode = node.parameters.jsCode
    .replace(/\$\('([^']+)'\)\.item\b/g, "$('$1').first()")
    .replace(/\$input\.item\b/g, '$input.first()');
}

byName.get('Validate Trigger Secret').parameters.jsCode = `const expected = ($env.N8N_PIPELINE_TRIGGER_SECRET || '').toString().trim();
if (!expected) {
  throw new Error('trigger secret is not configured');
}

const headers = $json.headers || {};
const provided = (headers['x-voc-trigger-secret'] || headers['X-Voc-Trigger-Secret'] || '')
  .toString()
  .trim();
if (!provided || provided !== expected) {
  throw new Error('trigger secret rejected');
}

return [{ json: { triggerSource: 'webhook' } }];`;
byName.get('Validate Trigger Secret').notes =
  'Webhook secret은 필수이며 누락 또는 불일치 시 claim 전에 실행을 중단한다.';

byName.get('Prepare Claim Job Payload').parameters.jsCode = `const claimKey = ($execution.id || '').toString().trim();
if (!claimKey) throw new Error('execution id is required');
return [{ json: { claimKey, payload: { claimKey } } }];`;

byName.get('Prepare Run Context').parameters.jsCode = `const data = $json.data || {};
const status = (data.status || '').toString().trim().toLowerCase();
const jobId = (data.jobId || '').toString().trim() || null;

if (!jobId || status !== 'running') {
  return [{ json: { hasClaim: false, status: status || 'empty' } }];
}

const claimToken = (data.claimToken || '').toString().trim();
const leaseExpiresAt = (data.leaseExpiresAt || '').toString().trim();
const attemptCount = Number(data.attemptCount);
if (!claimToken || !leaseExpiresAt || !Number.isInteger(attemptCount) || attemptCount < 1) {
  throw new Error('claim response is incomplete');
}

const appStoreId = (data.appStoreId || '').toString().trim();
if (!appStoreId) {
  throw new Error('claim response missing appStoreId');
}

const country = (data.country || 'kr').toString().trim().toLowerCase();
const appName = (data.appName || '').toString().trim();
const source = (data.source || '').toString().trim().toLowerCase();
const forceReanalysis = source === 'reanalysis';
const claimKey = $('Prepare Claim Job Payload').first().json.claimKey;
const runId = 'RUN_' + jobId + '_' + attemptCount;

const rawWindowDays = ($env.VOC_FETCH_WINDOW_DAYS || '30').toString().trim();
const parsedWindowDays = Number(rawWindowDays);
const fetchWindowDays = Number.isFinite(parsedWindowDays)
  ? Math.min(Math.max(Math.floor(parsedWindowDays), 1), 90)
  : 30;

const rawMaxPages = ($env.VOC_FETCH_MAX_PAGES || '40').toString().trim();
const parsedMaxPages = Number(rawMaxPages);
const fetchMaxPages = Number.isFinite(parsedMaxPages)
  ? Math.min(Math.max(Math.floor(parsedMaxPages), 1), 40)
  : 40;

const fetchPayload = {
  jobId,
  claimToken,
  runId,
  appStoreId,
  country,
  windowDays: fetchWindowDays,
  maxPages: fetchMaxPages,
};

return [{ json: {
  hasClaim: true,
  runId,
  jobId,
  claimKey,
  claimToken,
  leaseExpiresAt,
  attemptCount,
  appStoreId,
  country,
  appName,
  source,
  forceReanalysis,
  status,
  fetchPayload,
} }];`;

setNode({
  parameters: {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' },
      conditions: [{
        id: 'has-active-claim',
        leftValue: "={{ $json.hasClaim === true ? 'yes' : 'no' }}",
        rightValue: 'yes',
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2,
  position: [0, 0],
  id: 'has-active-claim-v2',
  name: 'Has Active Claim?',
  notes: '빈 queue는 명시적인 false terminal branch로 종료해 production concurrency slot을 반환한다.',
});

byName.get('Prepare Preflight Reviews Payload').parameters.jsCode = `const context = $('Prepare Run Context').first().json || {};
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
} }];`;

const filterDuplicates = byName.get('Filter Duplicates');
if (!filterDuplicates.parameters.jsCode.includes('claimToken:')) {
  filterDuplicates.parameters.jsCode = filterDuplicates.parameters.jsCode.replace(
    '      jobId: row.jobId || context.jobId || null,',
    '      jobId: row.jobId || context.jobId || null,\n      claimToken: row.claimToken || context.claimToken || null,',
  );
}

const extractionPrompt = `={{ '# Review extraction input\\n' + JSON.stringify($json.reviews || []) + '\\n\\nReturn ONLY a JSON array. Preserve every review exactly once and use its exact reviewId. Do not invent or omit ids.\\n\\nEach object: {"reviewId":"exact id","priority":"Critical|High|Normal","category":"버그 및 성능|계정 및 결제|기능 및 사용성|콘텐츠 및 운영 정책|긍정 리뷰 및 기타","summary":"factual Korean sentence under 160 chars"}.\\n\\npriority is per-review operational impact only. Cluster severity is decided later. Do not output issue labels, actions, confidence, markdown, or prose.' }}`;
byName.get('Basic LLM Chain').parameters.text = extractionPrompt;
byName.get('Basic LLM Chain').notes =
  `Stage 1: 최대 50개 리뷰를 구조화한다. ${singleModelCallLeaseContract}`;
byName.get('Basic LLM Chain').alwaysOutputData = true;
byName.get('Google Gemini Chat Model').parameters.modelName = modelNameExpression;

byName.get('Ensure New Reviews').parameters.jsCode = `const context = $('Prepare Run Context').first().json || {};
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
} }));`;

byName.get('Parse JSON Response').parameters.jsCode = `const llmItems = $input.all();
const contextItems = $('Ensure New Reviews').all();
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const priorities = ['Critical', 'High', 'Normal'];
const parseJson = (value) => {
  const raw = (value || '').toString().replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
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
  const raw = llmItems.map((item) => item?.json?.text || item?.json?.output || '').join('\\n--- batch ---\\n');
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
return output;`;

setNode({
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: `const items = $input.all();
const parseErrors = items.filter((item) =>
  (item.json?.ID || '').toString().startsWith('PARSE_ERROR_')
);

if (parseErrors.length > 0) {
  return [{ json: { ...(parseErrors[0].json || {}) } }];
}

return items;`,
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [440, 260],
  id: 'gate-extraction-batches-v2',
  name: 'Gate Extraction Batches',
  notes: 'Stage 1 배치 중 하나라도 실패하면 성공 부분집합을 폐기하고 파싱 오류 1건만 전달한다.',
});

setNode({
  parameters: { jsCode: `const freshReviews = $('Filter Duplicates').all().map((item) => ({ ...(item.json || {}), isExisting: false }));
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
} }];` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [3280, 0],
  id: 'prepare-cluster-context-v2', name: 'Prepare Cluster Context',
  notes: '경보 게이트 완료 후 Filter Duplicates 원본을 직접 재사용하는 read-only context payload'
});
setNode({
  parameters: {
    method: 'POST',
    url: "={{ (($env.VOC_BFF_BASE_URL || '').toString().replace(/\\/$/, '')) + '/api/internal/pipeline/cluster-context' }}",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'content-type', value: 'application/json' },
      { name: 'x-voc-token', value: directSecretExpression },
      { name: 'x-idempotency-key', value: '={{ $json.runId }}' }
    ] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.payload }}',
    options: { timeout: 30000, response: { response: { responseFormat: 'json' } } }
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3, position: [3760, 0],
  id: 'fetch-cluster-context-v2', name: 'Fetch Cluster Context',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 1000
});
setNode({
  parameters: { jsCode: `const context = $('Prepare Cluster Context').first().json || {};
const reviewItems = Array.isArray(context.reviewItems) ? context.reviewItems : [];
if (reviewItems.length === 0) return [];
if (!Array.isArray($json.data)) throw new Error('existing cluster context must be an array');
if ($json.data.length > ${maxExistingClusterContextRows}) {
  throw new Error('existing cluster context exceeds ${maxExistingClusterContextRows} rows');
}

const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const utf8Length = (value) => new TextEncoder().encode(value).length;
const koreanSuffixes = ['으로부터', '에서부터', '에게서', '으로', '에서', '에게', '까지', '부터', '처럼', '하고', '하며', '은', '는', '이', '가', '을', '를', '에', '의', '도', '만'];
const tokenize = (...values) => {
  const text = values
    .map((value) => (value || '').toString())
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
  const rawTokens = text.match(/[가-힣]+|[a-z]+|[0-9]+/g) || [];
  const lexemes = new Set();
  for (const rawToken of rawTokens) {
    if (rawToken.length > 64) continue;
    if (/^[0-9]+$/.test(rawToken) || (/^[a-z]+$/.test(rawToken) && rawToken.length >= 2)) {
      lexemes.add(rawToken);
      continue;
    }
    if (!/^[가-힣]+$/.test(rawToken) || rawToken.length < 2) continue;
    lexemes.add(rawToken);
    let stem = rawToken;
    for (const suffix of koreanSuffixes) {
      if (stem.endsWith(suffix) && stem.length - suffix.length >= 2) {
        stem = stem.slice(0, -suffix.length);
        lexemes.add(stem);
        break;
      }
    }
  }
  return lexemes;
};

const seenIssueIds = new Set();
const seenCanonicalKeys = new Set();
const existingClusters = $json.data.map((row, index) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('invalid existing cluster row at index ' + index);
  }
  const issueId = (row.issueId || '').toString().trim();
  const canonicalKey = (row.canonicalKey || '').toString().trim();
  const title = (row.title || '').toString().trim();
  const category = (row.category || '').toString().trim();
  const summary = (row.summary || '').toString().trim();
  const firstSeenAt = (row.firstSeenAt || '').toString().trim();
  const lastSeenAt = (row.lastSeenAt || '').toString().trim();
  const firstSeenMs = Date.parse(firstSeenAt);
  const lastSeenMs = Date.parse(lastSeenAt);
  const reviewCount = Number(row.reviewCount);
  if (!issueId || issueId.length > 128 || seenIssueIds.has(issueId)) {
    throw new Error('invalid or duplicate existing cluster issueId at index ' + index);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey) || seenCanonicalKeys.has(canonicalKey)) {
    throw new Error('invalid or duplicate existing cluster canonicalKey at index ' + index);
  }
  if (!title || title.length > 120) throw new Error('invalid existing cluster title at index ' + index);
  if (!categories.includes(category)) throw new Error('invalid existing cluster category at index ' + index);
  if (!summary || summary.length > 400) throw new Error('invalid existing cluster summary at index ' + index);
  if (
    firstSeenAt.length > 64 || lastSeenAt.length > 64 ||
    !Number.isFinite(firstSeenMs) || !Number.isFinite(lastSeenMs) || firstSeenMs > lastSeenMs
  ) {
    throw new Error('invalid existing cluster occurrence window at index ' + index);
  }
  if (!Number.isSafeInteger(reviewCount) || reviewCount < 1) {
    throw new Error('invalid existing cluster reviewCount at index ' + index);
  }
  seenIssueIds.add(issueId);
  seenCanonicalKeys.add(canonicalKey);
  const normalized = {
    issueId, canonicalKey, title, category, summary,
    firstSeenAt, lastSeenAt, reviewCount,
  };
  return {
    normalized,
    tokens: tokenize(canonicalKey, title, summary),
    lastSeenMs,
    jsonBytes: utf8Length(JSON.stringify(normalized)),
  };
});
if (existingClusters.some((entry) => entry.jsonBytes + 2 > ${maxExistingClusterContextBytes})) {
  throw new Error('invalid existing cluster row exceeds the context byte budget');
}

const rawBatchLimit = ($env.VOC_CLUSTER_BATCH_LIMIT || '30').toString().trim();
const parsedBatchLimit = Number(rawBatchLimit);
const batchLimit = Number.isFinite(parsedBatchLimit)
  ? Math.min(Math.max(Math.floor(parsedBatchLimit), 10), 40)
  : 30;
const chunks = [];
for (let offset = 0; offset < reviewItems.length; offset += batchLimit) {
  chunks.push(reviewItems.slice(offset, offset + batchLimit));
}

const { reviewItems: ignoredFullReviewItems, ...sharedContext } = context;
return chunks.map((batchReviews, batchIndex) => {
  const batchCategories = [...new Set(batchReviews.map((review, reviewIndex) => {
    const reviewId = (review?.ID || review?.id || '').toString().trim();
    const category = (review?.category || review?.유형 || '').toString().trim();
    if (!reviewId) throw new Error('cluster batch reviewId is required at index ' + reviewIndex);
    if (!categories.includes(category)) throw new Error('invalid cluster batch category at index ' + reviewIndex);
    return category;
  }))].sort(compareText);
  const batchTokenCounts = new Map();
  for (const review of batchReviews) {
    const reviewTokens = tokenize(
      (review.summary || review.요약 || '').toString().slice(0, 2000),
      (review.content || review.원본 || '').toString().slice(0, 4000),
    );
    for (const lexeme of reviewTokens) {
      batchTokenCounts.set(lexeme, (batchTokenCounts.get(lexeme) || 0) + 1);
    }
  }

  const ranked = existingClusters.map((entry) => {
    let lexicalScore = 0;
    let lexicalHitCount = 0;
    for (const lexeme of entry.tokens) {
      const frequency = batchTokenCounts.get(lexeme) || 0;
      if (frequency > 0) {
        lexicalScore += frequency;
        lexicalHitCount += 1;
      }
    }
    return {
      ...entry,
      categoryMatch: batchCategories.includes(entry.normalized.category) ? 1 : 0,
      lexicalScore,
      lexicalHitCount,
    };
  });
  const relevanceComparator = (left, right) =>
    right.lexicalScore - left.lexicalScore ||
    right.lexicalHitCount - left.lexicalHitCount ||
    right.categoryMatch - left.categoryMatch ||
    right.normalized.reviewCount - left.normalized.reviewCount ||
    right.lastSeenMs - left.lastSeenMs ||
    compareText(left.normalized.canonicalKey, right.normalized.canonicalKey) ||
    compareText(left.normalized.issueId, right.normalized.issueId);
  const anchorComparator = (left, right) =>
    right.normalized.reviewCount - left.normalized.reviewCount ||
    right.lastSeenMs - left.lastSeenMs ||
    compareText(left.normalized.canonicalKey, right.normalized.canonicalKey) ||
    compareText(left.normalized.issueId, right.normalized.issueId);

  let selectedEntries;
  let contextBytes = 2;
  const completeContextBytes = 2 + existingClusters.reduce(
    (total, entry, index) => total + entry.jsonBytes + (index === 0 ? 0 : 1),
    0,
  );
  if (
    existingClusters.length <= ${preserveAllExistingClusterThreshold} &&
    completeContextBytes <= ${maxExistingClusterContextBytes}
  ) {
    selectedEntries = [...existingClusters];
    contextBytes = completeContextBytes;
  } else {
    const rankedByRelevance = [...ranked].sort(relevanceComparator);
    const primaryEntries = [];
    const optionalEntries = [];
    const queuedIds = new Set();
    const queueEntry = (target, entry) => {
      if (entry && !queuedIds.has(entry.normalized.issueId)) {
        queuedIds.add(entry.normalized.issueId);
        target.push(entry);
      }
    };

    for (const category of batchCategories) {
      const categoryEntries = ranked
        .filter((entry) => entry.normalized.category === category)
        .sort(anchorComparator);
      queueEntry(primaryEntries, categoryEntries[0]);
    }
    queueEntry(primaryEntries, rankedByRelevance.find((entry) => entry.lexicalScore > 0));
    for (const category of batchCategories) {
      const categoryEntries = ranked
        .filter((entry) => entry.normalized.category === category)
        .sort(anchorComparator);
      queueEntry(optionalEntries, categoryEntries[1]);
      queueEntry(
        optionalEntries,
        categoryEntries.filter((entry) => entry.lexicalScore > 0).sort(relevanceComparator)[0],
      );
    }
    for (const entry of rankedByRelevance.filter((candidate) => candidate.lexicalScore > 0).slice(0, 8)) {
      queueEntry(optionalEntries, entry);
    }

    selectedEntries = [];
    const selectedIds = new Set();
    const addSelected = (entry) => {
      if (!entry || selectedIds.has(entry.normalized.issueId)) return true;
      const nextBytes = contextBytes + entry.jsonBytes + (selectedEntries.length === 0 ? 0 : 1);
      if (selectedEntries.length >= ${maxSelectedExistingClusters} || nextBytes > ${maxExistingClusterContextBytes}) {
        return false;
      }
      selectedEntries.push(entry);
      selectedIds.add(entry.normalized.issueId);
      contextBytes = nextBytes;
      return true;
    };
    for (const entry of primaryEntries) addSelected(entry);
    for (const entry of optionalEntries) addSelected(entry);
    for (const entry of rankedByRelevance) addSelected(entry);
    if (existingClusters.length > 0 && selectedEntries.length === 0) {
      throw new Error('existing cluster context selection produced no rows');
    }
  }

  const selectedClusters = selectedEntries.map((entry) => entry.normalized);
  const measuredContextBytes = utf8Length(JSON.stringify(selectedClusters));
  if (
    selectedClusters.length > ${maxSelectedExistingClusters} ||
    measuredContextBytes !== contextBytes ||
    measuredContextBytes > ${maxExistingClusterContextBytes}
  ) {
    throw new Error('existing cluster context selection exceeded its hard bounds');
  }

  return { json: {
    ...sharedContext,
    reviewItems: batchReviews,
    existingClusters: selectedClusters,
    existingClusterTotalCount: existingClusters.length,
    existingClusterSelectedCount: selectedClusters.length,
    existingClusterContextBytes: measuredContextBytes,
    clusterBatchIndex: batchIndex,
    clusterBatchCount: chunks.length,
    clusterBatchLimit: batchLimit,
  } };
});` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [4000, 0],
  id: 'prepare-cluster-input-v2', name: 'Prepare Cluster Input',
  notes: `클러스터링 입력을 최대 40개 리뷰로 나누고 기존 클러스터는 관련도 기준 최대 ${maxSelectedExistingClusters}개, ${maxExistingClusterContextBytes} UTF-8 bytes로 제한한다. 기존 클러스터가 ${preserveAllExistingClusterThreshold}개 이하이고 byte budget 이내면 전부 유지한다.`
});
setNode({
  parameters: {
    promptType: 'define',
    text: `={{ '# Existing issue clusters\\n' + JSON.stringify($json.existingClusters || []) + '\\n\\n# Review extractions\\n' + JSON.stringify(($json.reviewItems || []).map(r => ({reviewId:r.ID, category:r.category, summary:r.summary, rating:r.rating, content:r.content}))) + '\\n\\n# Task\\nGroup every review into exactly one primary issue. Match an existing issue when it describes the same underlying product problem; when matched, copy its issueId to existingClusterId and reuse its canonicalKey exactly. Otherwise create a stable lowercase ASCII kebab-case canonicalKey.\\n\\nReturn ONLY {"clusters":[{"existingClusterId":"uuid or null","canonicalKey":"stable-key","title":"short Korean noun phrase","category":"one allowed category","severity":"high|medium|low","summary":"evidence-bound Korean summary","actionHint":"one concrete next step","reviewIds":["exact ids"],"representativeReviewIds":["subset up to 3"]}]}.\\n\\nSeverity: high = blocks a core journey, loss/billing/security risk, or repeated crashes; medium = material friction with workaround; low = localized inconvenience or request. Use no confidence percentages. Every representativeReviewId must be copied verbatim from that same cluster reviewIds array; omit representativeReviewIds rather than guessing. Inventing, omitting, or duplicating a review id is a hard failure.' }}`,
    batching: {}
  },
  type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.8, position: [4240, 80],
  id: 'cluster-review-issues-v2', name: 'Cluster Review Issues', executeOnce: false,
  retryOnFail: true, waitBetweenTries: 3000, maxTries: 3, continueOnFail: true,
  notes: `Stage 2: 최대 40개 리뷰를 클러스터링한다. ${singleModelCallLeaseContract}`
});
setNode({
  parameters: { mode: 'runOnceForAllItems', jsCode: `const context = $('Prepare Cluster Input').first().json || {};
const llm = $input.first().json || {};
const raw = (llm.text || llm.output || '').toString();
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const severities = ['high', 'medium', 'low'];
const errorItem = (message) => [{ json: { ID: 'PARSE_ERROR_CLUSTER_' + Date.now(), 긴급도: 'ERROR', 유형: '파싱실패', 요약: message, 원본: raw.slice(0, 4000), runId: context.runId, jobId: context.jobId, appStoreId: context.reviewItems?.[0]?.appStoreId, country: context.reviewItems?.[0]?.country } }];
try {
  const clean = raw.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  const parsed = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
  const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : [];
  if (!clusters.length) throw new Error('clusters must not be empty');
  const inputReviewIds = context.reviewItems.map((item) => (item.ID || '').toString());
  const expected = new Set(inputReviewIds); const assigned = new Set(); const keys = new Set();
  for (const cluster of clusters) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test((cluster.canonicalKey || '').toString())) throw new Error('invalid canonicalKey');
    if (keys.has(cluster.canonicalKey)) throw new Error('duplicate canonicalKey'); keys.add(cluster.canonicalKey);
    if (!categories.includes(cluster.category)) throw new Error('invalid cluster category');
    if (!severities.includes(cluster.severity)) throw new Error('invalid severity');
    if (!(cluster.title || '').toString().trim() || !(cluster.summary || '').toString().trim()) throw new Error('cluster title and summary are required');
    if (!Array.isArray(cluster.reviewIds) || cluster.reviewIds.length === 0) throw new Error('cluster reviewIds required');
    for (const id of cluster.reviewIds) {
      if (!expected.has(id)) throw new Error('unknown cluster reviewId: ' + id);
      if (assigned.has(id)) throw new Error('duplicate cluster assignment: ' + id);
      assigned.add(id);
    }
    const representatives = Array.isArray(cluster.representativeReviewIds) ? cluster.representativeReviewIds : cluster.reviewIds.slice(0, 3);
    if (representatives.some((id) => !cluster.reviewIds.includes(id))) throw new Error('representative review must be a member');
    cluster.representativeReviewIds = representatives;
  }
  const missing = inputReviewIds.filter((id) => !assigned.has(id));
  if (missing.length) throw new Error('unassigned reviewIds: ' + missing.join(','));
  const result = {
    extractions: context.reviewItems.map((item) => ({ reviewId: item.ID, category: item.category, summary: item.summary })),
    clusters
  };
  return [{ json: { ...context, inputReviewIds, result, validation: { passed: true, inputReviewCount: inputReviewIds.length, extractionCount: inputReviewIds.length, assignedReviewCount: assigned.size, clusterCount: clusters.length } } }];
} catch (error) { return errorItem(error.message || 'cluster validation failed'); }` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [4480, 80],
  id: 'validate-cluster-output-v2', name: 'Validate Cluster Output'
});
byName.get('Validate Cluster Output').parameters.jsCode = validateClusterOutputCode;
setNode({
  parameters: { mode: 'runOnceForAllItems', jsCode: mergeClusterBatchesCode },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [4720, 80],
  id: 'merge-cluster-batches-v2', name: 'Merge Cluster Batches',
  notes: '배치별 결과를 canonical identity로 병합한 뒤 전체 리뷰 정확히 1회 배정을 재검증한다.'
});
setNode({
  parameters: { mode: 'runOnceForAllItems', jsCode: `const context = $input.first().json || {};
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
  if (sourceClusters.length > ${maxCandidateCount}) {
    throw new Error('cluster candidate count exceeds ${maxCandidateCount}');
  }

  const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
  const severities = ['high', 'medium', 'low'];
  const candidates = sourceClusters.map((cluster, index) => {
    const canonicalKey = (cluster.canonicalKey || '').toString().trim();
    const title = (cluster.title || '').toString().trim();
    const summary = (cluster.summary || '').toString().trim();
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) throw new Error('invalid candidate canonicalKey');
    if (!title || title.length > ${maxCandidateTitleLength}) throw new Error('candidate title length is invalid');
    if (!summary || summary.length > ${maxCandidateSummaryLength}) throw new Error('candidate summary length is invalid');
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

  const promptPrefix = '# Candidate issue clusters\\n';
  const promptSuffix = '\\n\\n# Task\\nGroup every candidateId in this batch exactly once. Merge candidates only when they describe the same underlying product problem; keep materially different problems separate. existingClusterId must be null unless copied from a candidate in the same group. canonicalKey must be copied exactly from one candidate in the same group; when retaining an existingClusterId, copy that candidate canonicalKey.\\n\\nReturn ONLY {"groups":[{"candidateIds":["candidate-0"],"existingClusterId":"source uuid or null","canonicalKey":"exact source key","title":"short Korean noun phrase","category":"버그 및 성능|계정 및 결제|기능 및 사용성|콘텐츠 및 운영 정책|긍정 리뷰 및 기타","severity":"high|medium|low","summary":"evidence-bound Korean summary","actionHint":"one concrete next step"}]}. Do not output review IDs, confidence, markdown, or prose.';
  const utf8Length = (value) => new TextEncoder().encode(value).length;
  const renderPrompt = (batch) => promptPrefix + JSON.stringify(batch) + promptSuffix;
  const batches = [];
  let current = [];

  for (const candidate of candidates) {
    const next = [...current, candidate];
    const nextPrompt = renderPrompt(next);
    if (next.length > ${maxConsolidationCandidates} || utf8Length(nextPrompt) > ${maxConsolidationPromptBytes}) {
      if (current.length === 0) throw new Error('one candidate exceeds the consolidation prompt budget');
      batches.push(current);
      current = [candidate];
      if (utf8Length(renderPrompt(current)) > ${maxConsolidationPromptBytes}) {
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
    if (batch.length > ${maxConsolidationCandidates} || promptBytes > ${maxConsolidationPromptBytes}) {
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
}` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [4960, 80],
  id: 'prepare-consolidation-batches-v2', name: 'Prepare Consolidation Batches',
  notes: `후보를 최대 ${maxConsolidationCandidates}개, 전체 UTF-8 prompt ${maxConsolidationPromptBytes} bytes 단위로 정렬·분할한다. 후보는 자르거나 버리지 않는다.`
});
setNode({
  parameters: JSON.parse(JSON.stringify(byName.get('Has Parse Error?').parameters)),
  type: 'n8n-nodes-base.if', typeVersion: 2, position: [5200, 80],
  id: 'has-consolidation-input-error-v2', name: 'Has Consolidation Input Error?'
});
setNode({
  parameters: {
    promptType: 'define',
    text: '={{ $json.prompt }}',
    batching: {},
  },
  type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.8, position: [4960, 80],
  id: 'consolidate-cluster-candidates-v2', name: 'Consolidate Cluster Candidates', executeOnce: false,
  retryOnFail: true, waitBetweenTries: 3000, maxTries: 3, continueOnFail: true,
  notes: `후보 최대 ${maxConsolidationCandidates}개와 ${maxConsolidationPromptBytes} UTF-8 bytes 이하 prompt를 통합한다. ${singleModelCallLeaseContract}`
});
setNode({
  parameters: { mode: 'runOnceForAllItems', jsCode: `const contexts = $('Prepare Consolidation Batches').all().map((item) => item.json || {});
const llmItems = $input.all();
const sourceContext = $('Merge Cluster Batches').first().json || {};
const rawResponses = llmItems.map((item) => (item.json?.text || item.json?.output || '').toString());
const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const severities = ['high', 'medium', 'low'];
const errorItem = (message, raw = '') => [{ json: {
  ID: 'PARSE_ERROR_CLUSTER_CONSOLIDATION_' + Date.now(),
  긴급도: 'ERROR', 유형: '파싱실패', 요약: message, 원본: raw.slice(0, 4000),
  runId: sourceContext.runId, jobId: sourceContext.jobId, claimToken: sourceContext.claimToken,
  appStoreId: sourceContext.reviewItems?.[0]?.appStoreId,
  country: sourceContext.reviewItems?.[0]?.country,
} }];

try {
  if (llmItems.length !== contexts.length) {
    throw new Error('consolidation batch count mismatch: expected ' + contexts.length + ', received ' + llmItems.length);
  }
  const sourceClusters = Array.isArray(sourceContext.result?.clusters) ? sourceContext.result.clusters : [];
  const sourceById = new Map(sourceClusters.map((cluster, index) => ['candidate-' + index, cluster]));
  const expectedCandidateIds = contexts.flatMap((context) =>
    (Array.isArray(context.candidates) ? context.candidates : []).map((candidate) => candidate.candidateId)
  );
  if (expectedCandidateIds.length !== sourceClusters.length || new Set(expectedCandidateIds).size !== sourceClusters.length) {
    throw new Error('consolidation input candidate partition is incomplete');
  }
  if (expectedCandidateIds.some((candidateId) => !sourceById.has(candidateId))) {
    throw new Error('consolidation input contains an unknown candidateId');
  }

  const assignedCandidates = new Set();
  const canonicalKeys = new Set();
  const clusters = [];

  for (let batchIndex = 0; batchIndex < contexts.length; batchIndex += 1) {
    const context = contexts[batchIndex] || {};
    const raw = rawResponses[batchIndex] || '';
    const clean = raw.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean);
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    if (groups.length === 0) throw new Error('consolidation groups must not be empty');

    const batchCandidateIds = (Array.isArray(context.candidates) ? context.candidates : [])
      .map((candidate) => candidate.candidateId);
    const batchExpected = new Set(batchCandidateIds);
    const batchAssigned = new Set();

    for (const group of groups) {
      if (!Array.isArray(group.candidateIds) || group.candidateIds.length === 0) {
        throw new Error('consolidation candidateIds required');
      }
      const groupCandidateIds = group.candidateIds.map((value) => (value || '').toString().trim());
      const sourceGroup = [];
      for (const candidateId of groupCandidateIds) {
        if (!batchExpected.has(candidateId)) throw new Error('unknown or cross-batch consolidation candidateId: ' + candidateId);
        if (batchAssigned.has(candidateId) || assignedCandidates.has(candidateId)) {
          throw new Error('duplicate consolidation candidate assignment: ' + candidateId);
        }
        batchAssigned.add(candidateId);
        assignedCandidates.add(candidateId);
        sourceGroup.push(sourceById.get(candidateId));
      }

      const existingIds = [...new Set(sourceGroup.map((cluster) => cluster.existingClusterId).filter(Boolean))];
      const existingClusterId = (group.existingClusterId || '').toString().trim() || null;
      if (existingIds.length > 0 && !existingIds.includes(existingClusterId)) {
        throw new Error('consolidation must retain one source existingClusterId');
      }
      if (existingIds.length === 0 && existingClusterId) throw new Error('consolidation invented existingClusterId');

      const canonicalKey = (group.canonicalKey || '').toString().trim();
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey)) throw new Error('invalid consolidated canonicalKey');
      if (!sourceGroup.some((cluster) => cluster.canonicalKey === canonicalKey)) {
        throw new Error('consolidation canonicalKey must come from its source candidates');
      }
      if (existingClusterId) {
        const retained = sourceGroup.find((cluster) => cluster.existingClusterId === existingClusterId);
        if (!retained || retained.canonicalKey !== canonicalKey) {
          throw new Error('consolidation changed retained existing canonicalKey');
        }
      }
      if (canonicalKeys.has(canonicalKey)) throw new Error('duplicate consolidated canonicalKey');
      canonicalKeys.add(canonicalKey);
      if (!categories.includes(group.category)) throw new Error('invalid consolidated category');
      if (!severities.includes(group.severity)) throw new Error('invalid consolidated severity');

      const title = (group.title || '').toString().trim();
      const summary = (group.summary || '').toString().trim();
      const actionHint = (group.actionHint || '').toString().trim();
      if (!title || title.length > ${maxCandidateTitleLength}) throw new Error('consolidated title length is invalid');
      if (!summary || summary.length > ${maxCandidateSummaryLength}) throw new Error('consolidated summary length is invalid');
      if (actionHint.length > ${maxCandidateActionLength}) throw new Error('consolidated actionHint length is invalid');

      const reviewIds = [...new Set(sourceGroup.flatMap((cluster) => cluster.reviewIds || []))];
      const representativeReviewIds = [...new Set(
        sourceGroup.flatMap((cluster) => cluster.representativeReviewIds || [])
      )].filter((reviewId) => reviewIds.includes(reviewId)).slice(0, 3);
      clusters.push({
        existingClusterId, canonicalKey, title, category: group.category, severity: group.severity,
        summary, actionHint, reviewIds, representativeReviewIds,
      });
    }

    const missingBatchCandidates = batchCandidateIds.filter((candidateId) => !batchAssigned.has(candidateId));
    if (missingBatchCandidates.length > 0) {
      throw new Error('unassigned batch candidateIds: ' + missingBatchCandidates.join(','));
    }
  }

  const missingCandidates = expectedCandidateIds.filter((candidateId) => !assignedCandidates.has(candidateId));
  if (missingCandidates.length > 0 || assignedCandidates.size !== sourceClusters.length) {
    throw new Error('not every consolidation candidate was assigned exactly once');
  }

  const inputReviewIds = Array.isArray(sourceContext.inputReviewIds) ? sourceContext.inputReviewIds : [];
  const expectedReviews = new Set(inputReviewIds);
  const assignedReviews = new Set();
  for (const cluster of clusters) {
    for (const reviewId of cluster.reviewIds) {
      if (!expectedReviews.has(reviewId)) throw new Error('unknown consolidated reviewId: ' + reviewId);
      if (assignedReviews.has(reviewId)) throw new Error('duplicate consolidated reviewId: ' + reviewId);
      assignedReviews.add(reviewId);
    }
  }
  const missingReviews = inputReviewIds.filter((reviewId) => !assignedReviews.has(reviewId));
  if (missingReviews.length > 0) throw new Error('unassigned consolidated reviewIds: ' + missingReviews.join(','));

  return [{ json: {
    ...sourceContext,
    result: { extractions: sourceContext.result?.extractions || [], clusters },
    validation: {
      ...(sourceContext.validation || {}), passed: true,
      assignedReviewCount: assignedReviews.size,
      clusterCount: clusters.length,
      candidateClusterCount: sourceClusters.length,
      consolidationBatchCount: contexts.length,
    },
  } }];
} catch (error) {
  return errorItem(error.message || 'cluster consolidation failed', rawResponses.join('\\n--- batch ---\\n'));
}` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [5200, 80],
  id: 'validate-consolidated-clusters-v2', name: 'Validate Consolidated Clusters',
  notes: '모든 bounded batch 결과를 결합하고 후보·리뷰가 정확히 한 번 배정됐는지 전역 검증한다.'
});
setNode({
  parameters: JSON.parse(JSON.stringify(byName.get('Has Parse Error?').parameters)),
  type: 'n8n-nodes-base.if', typeVersion: 2, position: [5440, 80],
  id: 'has-cluster-error-v2', name: 'Has Cluster Error?'
});

for (const name of ['Cluster Review Issues', 'Consolidate Cluster Candidates']) {
  byName.get(name).alwaysOutputData = true;
}

const checkpointCode = (stage, phase) => `const context = $('Prepare Run Context').first().json || {};
const jobId = (context.jobId || '').toString().trim();
const claimToken = (context.claimToken || '').toString().trim();
const runId = (context.runId || '').toString().trim();
if (!jobId || !claimToken || !runId) throw new Error('heartbeat claim context is incomplete');

let resultItems = $input.all().map((item) => ({ json: { ...(item.json || {}) } }));
if (resultItems.length !== 1) {
  resultItems = [{ json: {
    text: '',
    modelCardinalityError: '${phase} model result count mismatch: expected 1, received ' + resultItems.length,
  } }];
}

return [{ json: {
  runId,
  phase: '${phase}',
  resultItems,
  heartbeatPayload: { jobId, claimToken, runId, stage: '${stage}' },
} }];`;

const restoreCheckpointCode = (checkpointName, stage) => `const heartbeat = $input.first().json?.data || {};
if ((heartbeat.status || '').toString() !== 'running' || heartbeat.stage !== '${stage}') {
  throw new Error('pipeline heartbeat response is incomplete');
}
// Checkpoint and restore execute once per splitInBatches iteration. Pinning the
// checkpoint lookup to this restore run prevents an earlier batch from being reused.
const checkpoint = $('${checkpointName}').first(0, $runIndex).json || {};
const resultItems = Array.isArray(checkpoint.resultItems) ? checkpoint.resultItems : [];
if (resultItems.length === 0) throw new Error('pipeline checkpoint result is missing');
return resultItems.map((item) => ({ json: { ...(item.json || {}) } }));`;

const heartbeatHttpParameters = {
  method: 'POST',
  url: "={{ (($env.VOC_BFF_BASE_URL || '').toString().replace(/\\/$/, '')) + '/api/internal/pipeline/heartbeat' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'content-type', value: 'application/json' },
    { name: 'x-voc-token', value: directSecretExpression },
    { name: 'x-idempotency-key', value: '={{ $json.runId }}' },
  ] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ $json.heartbeatPayload }}',
  options: { timeout: 30000, response: { response: { responseFormat: 'json' } } },
};

for (const [name, id] of [
  ['Loop Extraction Batches', 'loop-extraction-batches-v2'],
  ['Loop Cluster Batches', 'loop-cluster-batches-v2'],
  ['Loop Consolidation Batches', 'loop-consolidation-batches-v2'],
]) {
  setNode({
    parameters: { batchSize: 1, options: {} },
    type: 'n8n-nodes-base.splitInBatches',
    typeVersion: 3,
    position: [0, 0],
    id,
    name,
    notes: '각 모델 배치를 단독 실행하고 완료 결과를 순서대로 결합한다.',
  });
}

for (const [name, id, stage, phase] of [
  ['Checkpoint Extraction Lease', 'checkpoint-extraction-lease-v2', 'extracting', 'extraction'],
  ['Checkpoint Cluster Lease', 'checkpoint-cluster-lease-v2', 'clustering', 'cluster'],
  ['Checkpoint Consolidation Lease', 'checkpoint-consolidation-lease-v2', 'clustering', 'consolidation'],
]) {
  setNode({
    parameters: { mode: 'runOnceForAllItems', jsCode: checkpointCode(stage, phase) },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [0, 0],
    id,
    name,
    notes: '외부 모델 응답을 보관하고 현재 fenced claim 갱신 payload를 만든다.',
  });
}

for (const [name, id] of [
  ['Renew Extraction Lease', 'renew-extraction-lease-v2'],
  ['Renew Cluster Lease', 'renew-cluster-lease-v2'],
  ['Renew Consolidation Lease', 'renew-consolidation-lease-v2'],
]) {
  setNode({
    parameters: JSON.parse(JSON.stringify(heartbeatHttpParameters)),
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.3,
    position: [0, 0],
    id,
    name,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 1000,
    notes: '모델 배치가 끝날 때 claim token을 검증하고 다음 15분 lease를 갱신한다.',
  });
}

for (const [name, id, checkpointName, stage] of [
  ['Restore Extraction Result', 'restore-extraction-result-v2', 'Checkpoint Extraction Lease', 'extracting'],
  ['Restore Cluster Result', 'restore-cluster-result-v2', 'Checkpoint Cluster Lease', 'clustering'],
  ['Restore Consolidation Result', 'restore-consolidation-result-v2', 'Checkpoint Consolidation Lease', 'clustering'],
]) {
  setNode({
    parameters: { mode: 'runOnceForAllItems', jsCode: restoreCheckpointCode(checkpointName, stage) },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [0, 0],
    id,
    name,
    notes: '갱신에 성공한 현재 claimant의 모델 응답만 다음 단계로 전달한다.',
  });
}

byName.get('Prepare Upsert Payload').position = [5680, 0];
byName.get('Prepare Upsert Payload').parameters.jsCode = `const context = $input.first().json || {};
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
const modelVersion = ${modelVersionResolver};
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
} } }];`;
byName.get('Upsert Reviews to BFF').position = [6160, 0];

setNode({
  parameters: { jsCode: `const upsert = $('Prepare Upsert Payload').first().json || {};
const app = upsert.payload?.app || {};
return [{ json: { runId: upsert.runId, jobId: upsert.jobId, claimToken: upsert.claimToken, payload: {
  runId: upsert.runId, jobId: upsert.jobId, claimToken: upsert.claimToken,
  appStoreId: app.appStoreId, country: app.country,
  modelVersion: upsert.modelVersion, comparisonEligible: upsert.comparisonEligible,
  inputReviewIds: upsert.inputReviewIds, result: upsert.clusterResult
} } }];` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [6400, 0],
  id: 'prepare-cluster-upsert-v2', name: 'Prepare Cluster Upsert'
});
setNode({
  parameters: {
    method: 'POST',
    url: "={{ (($env.VOC_BFF_BASE_URL || '').toString().replace(/\\/$/, '')) + '/api/internal/pipeline/upsert-clusters' }}",
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'content-type', value: 'application/json' },
      { name: 'x-voc-token', value: directSecretExpression },
      { name: 'x-idempotency-key', value: '={{ $json.runId }}' }
    ] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.payload }}',
    options: { timeout: 30000, response: { response: { responseFormat: 'json' } } }
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3, position: [6880, 0],
  id: 'upsert-clusters-to-bff-v2', name: 'Upsert Clusters to BFF',
  retryOnFail: true, maxTries: 3, waitBetweenTries: 1000
});

byName.get('Prepare Publish Payload').position = [7120, 0];
byName.get('Notify Publish to BFF').position = [7600, 0];

byName.get('Prepare Publish Payload').parameters.jsCode = `const upsertContext = $('Prepare Upsert Payload').first().json || {};
const payload = upsertContext.payload || {};
const runId = ($json.runId || upsertContext.runId || '').toString().trim();
const jobId = (upsertContext.jobId || payload.jobId || '').toString().trim();
const claimToken = (upsertContext.claimToken || payload.claimToken || '').toString().trim();
const appStoreId = (payload.app?.appStoreId || '').toString().trim();
const country = (payload.app?.country || 'kr').toString().trim().toLowerCase();

if (!runId || !jobId || !claimToken || !appStoreId) {
  throw new Error('publish context is incomplete');
}

return [{ json: {
  runId,
  jobId,
  claimToken,
  payload: {
    runId,
    jobId,
    claimToken,
    appStoreId,
    country,
    publishedAt: new Date().toISOString(),
  },
} }];`;

byName.get('Prepare Parse Error Payload').parameters.jsCode = `const item = $input.first().json || {};
const context = $('Prepare Run Context').first().json || {};
const appStoreId = (item.appStoreId || context.appStoreId || '').toString().trim() || null;
const country = (item.country || context.country || '').toString().trim().toLowerCase() || null;
const runId = (item.runId || context.runId || '').toString().trim();
const jobId = (item.jobId || context.jobId || '').toString().trim();
const claimToken = (item.claimToken || context.claimToken || '').toString().trim();
if (!runId || !jobId || !claimToken) throw new Error('parse error context is incomplete');

const payload = {
  parseErrorId: (item.ID || 'PARSE_ERROR_' + Date.now()).toString(),
  jobId,
  claimToken,
  runId,
  appStoreId,
  country,
  message: (item.요약 || item.message || 'No valid data parsed').toString(),
  rawResponse: (item.원본 || '').toString(),
};

return [{ json: { runId, jobId, claimToken, payload } }];`;

byName.get('Prepare Alert Events Payload').parameters.mode = 'runOnceForAllItems';
byName.get('Prepare Alert Events Payload').parameters.jsCode = `const inputItems = $input.all();
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

const normalizePriority = (value) => {
  const normalized = (value || '').toString().replace(/[🚨⚠️✅]/g, '').trim().toLowerCase();
  if (normalized.includes('critical')) return 'Critical';
  if (normalized.includes('high')) return 'High';
  return 'Normal';
};
// Keep this rule in lockstep with the Worker's derivePriorityValue contract.
const derivePriority = (rating, category, rawPriority) => {
  const normalized = normalizePriority(rawPriority);
  if (normalized !== 'Normal') return normalized;
  if (rating <= 1 && (category === '버그 및 성능' || category === '계정 및 결제')) return 'Critical';
  if (rating <= 2 && category !== '긍정 리뷰 및 기타') return 'High';
  return normalized;
};
const alerts = inputItems.map(({ json = {} }) => {
  const rating = Number((json.rating || json.별점 || '0').toString().trim()) || 0;
  const category = (json.category || json.유형 || '').toString().trim();
  return {
    reviewId: (json.reviewId || json.ID || json.id || '').toString().trim(),
    rating,
    priority: derivePriority(rating, category, json.priority || json.긴급도),
    category,
    summary: (json.summary || json.요약 || '').toString().trim(),
    sentAt: new Date().toISOString(),
  };
}).filter((alert) => alert.reviewId && alert.rating > 0 && alert.priority === 'Critical');

return [{ json: {
  runId,
  jobId,
  claimToken,
  hasCriticalAlerts: alerts.length > 0,
  payload: { runId, jobId, claimToken, appStoreId, country, alerts },
} }];`;

setNode({
  parameters: {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'strict' },
      conditions: [{
        id: 'has-critical-alerts',
        leftValue: "={{ $json.hasCriticalAlerts === true ? 'yes' : 'no' }}",
        rightValue: 'yes',
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2,
  position: [1320, 260],
  id: 'has-critical-alerts-v2',
  name: 'Has Critical Alerts?',
  notes: 'Critical 이벤트가 있으면 저장 완료 후에만 분석 파이프라인을 계속한다.',
});

removeNodes([
  'Sign Claim Job Payload',
  'Sign Preflight Reviews Payload',
  'Sign Cluster Context',
  'Sign Upsert Payload',
  'Sign Cluster Upsert',
  'Sign Publish Payload',
  'Sign Parse Error Payload',
  'Sign Alert Events Payload',
  'Check Critical Priority',
  'Restore Reviews After Alerts',
]);

configureInternalHttpNode('Claim Job from BFF', '={{ $json.claimKey }}');
for (const name of [
  'HTTP Request',
  'Filter New Reviews via BFF',
  'Fetch Cluster Context',
  'Upsert Reviews to BFF',
  'Upsert Clusters to BFF',
  'Notify Publish to BFF',
  'Send Parse Error to BFF',
  'Send Alert Events to BFF',
  'Renew Extraction Lease',
  'Renew Cluster Lease',
  'Renew Consolidation Lease',
]) {
  configureInternalHttpNode(name, '={{ $json.runId || $json.payload?.runId || $execution.id }}');
}
for (const [name, timeout] of internalHttpTimeouts) {
  const node = byName.get(name);
  node.parameters.options = {
    ...(node.parameters.options || {}),
    timeout,
  };
}

const scheduleTrigger = byName.get('Schedule Trigger (Queue Polling)');
scheduleTrigger.parameters = {
  rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] },
  timezone: 'Asia/Seoul',
};
scheduleTrigger.notes =
  'Webhook 전달이 누락된 queued job을 5분마다 회수한다. Production concurrency는 1로 제한한다.';

byName.get('HTTP Request').notes =
  'Worker BFF가 기본 최근 30일 리뷰를 최대 40페이지와 terminal probe 1회로 수집한다. 300초 안에 범위 완전성을 증명하지 못하면 부분 데이터를 반환하지 않고 작업을 실패 처리한다.';

workflow.connections['Ensure New Reviews'] = { main: [[{ node: 'Loop Extraction Batches', type: 'main', index: 0 }]] };
workflow.connections['Loop Extraction Batches'] = { main: [
  [{ node: 'Parse JSON Response', type: 'main', index: 0 }],
  [{ node: 'Basic LLM Chain', type: 'main', index: 0 }],
] };
workflow.connections['Basic LLM Chain'] = { main: [[{ node: 'Checkpoint Extraction Lease', type: 'main', index: 0 }]] };
workflow.connections['Checkpoint Extraction Lease'] = { main: [[{ node: 'Renew Extraction Lease', type: 'main', index: 0 }]] };
workflow.connections['Renew Extraction Lease'] = { main: [[{ node: 'Restore Extraction Result', type: 'main', index: 0 }]] };
workflow.connections['Restore Extraction Result'] = { main: [[{ node: 'Loop Extraction Batches', type: 'main', index: 0 }]] };
workflow.connections['Parse JSON Response'] = { main: [[{ node: 'Gate Extraction Batches', type: 'main', index: 0 }]] };
workflow.connections['Gate Extraction Batches'] = { main: [[{ node: 'Has Parse Error?', type: 'main', index: 0 }]] };
workflow.connections['Filter Duplicates'] = { main: [[{ node: 'Prepare Alert Events Payload', type: 'main', index: 0 }]] };
workflow.connections['Prepare Alert Events Payload'] = { main: [[{ node: 'Has Critical Alerts?', type: 'main', index: 0 }]] };
workflow.connections['Has Critical Alerts?'] = { main: [
  [{ node: 'Send Alert Events to BFF', type: 'main', index: 0 }],
  [{ node: 'Prepare Cluster Context', type: 'main', index: 0 }]
] };
workflow.connections['Send Alert Events to BFF'] = { main: [[{ node: 'Prepare Cluster Context', type: 'main', index: 0 }]] };
workflow.connections['Prepare Cluster Context'] = { main: [[{ node: 'Fetch Cluster Context', type: 'main', index: 0 }]] };
workflow.connections['Fetch Cluster Context'] = { main: [[{ node: 'Prepare Cluster Input', type: 'main', index: 0 }]] };
workflow.connections['Prepare Cluster Input'] = { main: [[{ node: 'Loop Cluster Batches', type: 'main', index: 0 }]] };
workflow.connections['Loop Cluster Batches'] = { main: [
  [{ node: 'Validate Cluster Output', type: 'main', index: 0 }],
  [{ node: 'Cluster Review Issues', type: 'main', index: 0 }],
] };
workflow.connections['Google Gemini Chat Model'].ai_languageModel[0] = [
  { node: 'Basic LLM Chain', type: 'ai_languageModel', index: 0 },
  { node: 'Cluster Review Issues', type: 'ai_languageModel', index: 0 },
  { node: 'Consolidate Cluster Candidates', type: 'ai_languageModel', index: 0 }
];
workflow.connections['Cluster Review Issues'] = { main: [[{ node: 'Checkpoint Cluster Lease', type: 'main', index: 0 }]] };
workflow.connections['Checkpoint Cluster Lease'] = { main: [[{ node: 'Renew Cluster Lease', type: 'main', index: 0 }]] };
workflow.connections['Renew Cluster Lease'] = { main: [[{ node: 'Restore Cluster Result', type: 'main', index: 0 }]] };
workflow.connections['Restore Cluster Result'] = { main: [[{ node: 'Loop Cluster Batches', type: 'main', index: 0 }]] };
workflow.connections['Validate Cluster Output'] = { main: [[{ node: 'Merge Cluster Batches', type: 'main', index: 0 }]] };
workflow.connections['Merge Cluster Batches'] = { main: [[{ node: 'Prepare Consolidation Batches', type: 'main', index: 0 }]] };
workflow.connections['Prepare Consolidation Batches'] = { main: [[{ node: 'Has Consolidation Input Error?', type: 'main', index: 0 }]] };
workflow.connections['Has Consolidation Input Error?'] = { main: [
  [{ node: 'Has Cluster Error?', type: 'main', index: 0 }],
  [{ node: 'Loop Consolidation Batches', type: 'main', index: 0 }],
] };
workflow.connections['Loop Consolidation Batches'] = { main: [
  [{ node: 'Validate Consolidated Clusters', type: 'main', index: 0 }],
  [{ node: 'Consolidate Cluster Candidates', type: 'main', index: 0 }],
] };
workflow.connections['Consolidate Cluster Candidates'] = { main: [[{ node: 'Checkpoint Consolidation Lease', type: 'main', index: 0 }]] };
workflow.connections['Checkpoint Consolidation Lease'] = { main: [[{ node: 'Renew Consolidation Lease', type: 'main', index: 0 }]] };
workflow.connections['Renew Consolidation Lease'] = { main: [[{ node: 'Restore Consolidation Result', type: 'main', index: 0 }]] };
workflow.connections['Restore Consolidation Result'] = { main: [[{ node: 'Loop Consolidation Batches', type: 'main', index: 0 }]] };
workflow.connections['Validate Consolidated Clusters'] = { main: [[{ node: 'Has Cluster Error?', type: 'main', index: 0 }]] };
workflow.connections['Has Cluster Error?'] = { main: [
  [{ node: 'Prepare Parse Error Payload', type: 'main', index: 0 }],
  [{ node: 'Prepare Upsert Payload', type: 'main', index: 0 }]
] };
workflow.connections['Upsert Reviews to BFF'] = { main: [[{ node: 'Prepare Cluster Upsert', type: 'main', index: 0 }]] };
workflow.connections['Prepare Cluster Upsert'] = { main: [[{ node: 'Upsert Clusters to BFF', type: 'main', index: 0 }]] };
workflow.connections['Upsert Clusters to BFF'] = { main: [[{ node: 'Prepare Publish Payload', type: 'main', index: 0 }]] };

workflow.connections['Prepare Claim Job Payload'] = { main: [[{ node: 'Claim Job from BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Run Context'] = { main: [[{ node: 'Has Active Claim?', type: 'main', index: 0 }]] };
workflow.connections['Has Active Claim?'] = { main: [
  [{ node: 'HTTP Request', type: 'main', index: 0 }],
  [],
] };
workflow.connections['Prepare Preflight Reviews Payload'] = { main: [[{ node: 'Filter New Reviews via BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Upsert Payload'] = { main: [[{ node: 'Upsert Reviews to BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Publish Payload'] = { main: [[{ node: 'Notify Publish to BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Parse Error Payload'] = { main: [[{ node: 'Send Parse Error to BFF', type: 'main', index: 0 }]] };

// Keep the operational canvas compact enough to inspect at fit-to-screen zoom.
// Positions are generated here so rebuilding the workflow cannot restore the
// previous 7,600px-wide single row.
const layout = {
  'Schedule Trigger (Queue Polling)': [-220, -120],
  'Webhook Trigger (Queue Event)': [-220, 100],
  'Validate Trigger Secret': [0, 100],
  'Prepare Claim Job Payload': [220, 0],
  'Claim Job from BFF': [440, 0],
  'Prepare Run Context': [660, 0],
  'Has Active Claim?': [880, 0],
  'HTTP Request': [1100, 0],
  'Prepare Preflight Reviews Payload': [1320, 0],
  'Filter New Reviews via BFF': [1540, 0],
  'Ensure New Reviews': [1760, 0],
  'Loop Extraction Batches': [1980, 0],

  'Basic LLM Chain': [0, 260],
  'Checkpoint Extraction Lease': [220, 260],
  'Renew Extraction Lease': [440, 260],
  'Restore Extraction Result': [660, 260],
  'Parse JSON Response': [880, 260],
  'Gate Extraction Batches': [1100, 260],
  'Has Parse Error?': [1320, 260],
  'Filter Duplicates': [1540, 260],
  'Prepare Alert Events Payload': [1760, 260],
  'Has Critical Alerts?': [1980, 260],
  'Send Alert Events to BFF': [2200, 260],
  'Google Gemini Chat Model': [1100, 410],

  'Prepare Cluster Context': [0, 560],
  'Fetch Cluster Context': [220, 560],
  'Prepare Cluster Input': [440, 560],
  'Loop Cluster Batches': [660, 560],
  'Cluster Review Issues': [880, 560],
  'Checkpoint Cluster Lease': [1100, 560],
  'Renew Cluster Lease': [1320, 560],
  'Restore Cluster Result': [1540, 560],
  'Validate Cluster Output': [1760, 560],
  'Merge Cluster Batches': [1980, 560],
  'Prepare Consolidation Batches': [2200, 560],
  'Has Consolidation Input Error?': [2420, 560],
  'Loop Consolidation Batches': [2640, 560],
  'Consolidate Cluster Candidates': [2860, 560],
  'Checkpoint Consolidation Lease': [3080, 560],
  'Renew Consolidation Lease': [3300, 560],
  'Restore Consolidation Result': [3520, 560],
  'Validate Consolidated Clusters': [3740, 560],
  'Has Cluster Error?': [3960, 560],

  'Prepare Upsert Payload': [0, 860],
  'Upsert Reviews to BFF': [220, 860],
  'Prepare Cluster Upsert': [440, 860],
  'Upsert Clusters to BFF': [660, 860],
  'Prepare Publish Payload': [880, 860],
  'Notify Publish to BFF': [1100, 860],
  'Prepare Parse Error Payload': [1320, 860],
  'Send Parse Error to BFF': [1540, 860],
};

for (const [name, position] of Object.entries(layout)) {
  const node = byName.get(name);
  if (!node) throw new Error(`Cannot position missing workflow node: ${name}`);
  node.position = position;
}

// The repository artifact uses a deterministic import ID. Instance metadata,
// execution data, and credential bindings belong to the private deployment.
for (const node of workflow.nodes) {
  delete node.credentials;
  delete node.webhookId;
}
byName.get('Webhook Trigger (Queue Event)').webhookId = 'voc-radar-queue-event';
workflow.id = 'voc-radar-pipeline-v2';
workflow.pinData = {};
workflow.tags = [];
const portableWorkflowFields = new Set([
  'id', 'name', 'nodes', 'pinData', 'connections', 'active', 'settings', 'tags',
]);
for (const field of Object.keys(workflow)) {
  if (!portableWorkflowFields.has(field)) delete workflow[field];
}

const generatedWorkflow = JSON.stringify(workflow, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (generatedWorkflow !== normalizedWorkflowSource) {
    throw new Error('n8n workflow is stale; run node scripts/build-workflow-v2.mjs');
  }
  console.log('n8n workflow matches the deterministic builder output.');
} else {
  await writeFile(workflowPath, generatedWorkflow);
  console.log('Updated n8n workflow with bounded model batches and fenced consolidation.');
}
