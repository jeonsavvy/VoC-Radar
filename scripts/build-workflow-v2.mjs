import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflowPath = resolve('n8n/workflow.supabase-only.json');
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const validateClusterOutputCode = await readFile(resolve('n8n/code/validate-cluster-output.js'), 'utf8');
const mergeClusterBatchesCode = await readFile(resolve('n8n/code/merge-cluster-batches.js'), 'utf8');
const validateConsolidatedClustersCode = await readFile(
  resolve('n8n/code/validate-consolidated-clusters.js'),
  'utf8',
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
  console.log('No active claim. Stop this run.');
  return [];
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

const rawMaxPages = ($env.VOC_FETCH_MAX_PAGES || '120').toString().trim();
const parsedMaxPages = Number(rawMaxPages);
const fetchMaxPages = Number.isFinite(parsedMaxPages)
  ? Math.min(Math.max(Math.floor(parsedMaxPages), 1), 200)
  : 120;

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
byName.get('Basic LLM Chain').notes = 'Stage 1: 리뷰별 구조화 추출. reviewId와 enum을 엄격히 보존한다.';

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
  parameters: { jsCode: `const freshReviews = $input.all().map((item) => ({ ...(item.json || {}), isExisting: false }));
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
  notes: '기존 클러스터 매칭을 위한 read-only context payload'
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
  parameters: { jsCode: `const reviewItems = $('Prepare Cluster Context').first().json.reviewItems || [];
const context = $('Prepare Cluster Context').first().json || {};
if (reviewItems.length === 0) return [];
const existingClusters = Array.isArray($json.data) ? $json.data : [];
const rawBatchLimit = ($env.VOC_CLUSTER_BATCH_LIMIT || '30').toString().trim();
const parsedBatchLimit = Number(rawBatchLimit);
const batchLimit = Number.isFinite(parsedBatchLimit)
  ? Math.min(Math.max(Math.floor(parsedBatchLimit), 10), 40)
  : 30;
const chunks = [];
for (let offset = 0; offset < reviewItems.length; offset += batchLimit) {
  chunks.push(reviewItems.slice(offset, offset + batchLimit));
}
return chunks.map((batchReviews, batchIndex) => ({ json: {
  ...context,
  reviewItems: batchReviews,
  existingClusters,
  clusterBatchIndex: batchIndex,
  clusterBatchCount: chunks.length,
  clusterBatchLimit: batchLimit
} }));` },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [4000, 0],
  id: 'prepare-cluster-input-v2', name: 'Prepare Cluster Input',
  notes: '클러스터링 입력을 최대 40개 리뷰 단위로 제한해 완전 배정 신뢰성을 유지한다.'
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
  notes: 'Stage 2: 기존 클러스터 매칭 또는 신규 클러스터 생성'
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
  parameters: {
    promptType: 'define',
    text: `={{ '# Candidate issue clusters\\n' + JSON.stringify(($json.result?.clusters || []).map((cluster, index) => ({ candidateId: 'candidate-' + index, existingClusterId: cluster.existingClusterId || null, canonicalKey: cluster.canonicalKey, title: cluster.title, category: cluster.category, severity: cluster.severity, summary: cluster.summary, reviewCount: (cluster.reviewIds || []).length }))) + '\\n\\n# Task\\nGroup every candidateId exactly once. Merge candidates only when they describe the same underlying product problem; keep materially different problems separate. If a group contains candidates with existingClusterId, retain exactly one of those source IDs and copy that candidate canonicalKey exactly. Otherwise use existingClusterId null and a stable lowercase ASCII kebab-case canonicalKey.\\n\\nReturn ONLY {"groups":[{"candidateIds":["candidate-0"],"existingClusterId":"source uuid or null","canonicalKey":"stable-key","title":"short Korean noun phrase","category":"버그 및 성능|계정 및 결제|기능 및 사용성|콘텐츠 및 운영 정책|긍정 리뷰 및 기타","severity":"high|medium|low","summary":"evidence-bound Korean summary","actionHint":"one concrete next step"}]}. Do not output review IDs, confidence, markdown, or prose.' }}`,
    batching: {},
  },
  type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.8, position: [4960, 80],
  id: 'consolidate-cluster-candidates-v2', name: 'Consolidate Cluster Candidates', executeOnce: false,
  retryOnFail: true, waitBetweenTries: 3000, maxTries: 3, continueOnFail: true,
  notes: '배치 경계에서 중복된 후보 이슈를 candidate ID 단위로 통합한다.'
});
setNode({
  parameters: { mode: 'runOnceForAllItems', jsCode: validateConsolidatedClustersCode },
  type: 'n8n-nodes-base.code', typeVersion: 2, position: [5200, 80],
  id: 'validate-consolidated-clusters-v2', name: 'Validate Consolidated Clusters',
  notes: '후보 ID와 근거 리뷰 멤버십을 결정론적으로 결합하고 전체 배정을 검증한다.'
});
setNode({
  parameters: JSON.parse(JSON.stringify(byName.get('Has Parse Error?').parameters)),
  type: 'n8n-nodes-base.if', typeVersion: 2, position: [5440, 80],
  id: 'has-cluster-error-v2', name: 'Has Cluster Error?'
});

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
const modelVersion = ($env.VOC_MODEL_VERSION || 'gemini-3-flash-preview').toString();
const reviews = reviewsInput.map((item) => {
  const id = (item.ID || '').toString();
  const cluster = clusters.find((entry) => Array.isArray(entry.reviewIds) && entry.reviewIds.includes(id));
  return {
    reviewId: id, rating: Number(item.rating) || 0, author: item.author || '', content: item.content || '', reviewedAt: item.date,
    priority: item.priority, category: item.category, issueLabel: cluster?.title || item.category,
    reasonSummary: cluster?.summary || item.summary, actionHint: cluster?.actionHint || '', summary: item.summary,
    modelVersion, rawSource: { id, content: item.content, author: item.author, rating: item.rating, date: item.date }
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

byName.get('Prepare Alert Events Payload').parameters.jsCode = `const inputItems = $input.all();
if (!Array.isArray(inputItems) || inputItems.length === 0) return [];

const context = $('Prepare Run Context').first().json || {};
const first = inputItems[0].json || {};
const appStoreId = (first.appStoreId || context.appStoreId || '').toString().trim();
const country = (first.country || context.country || 'kr').toString().trim().toLowerCase();
const runId = (first.runId || context.runId || '').toString().trim();
const jobId = (first.jobId || context.jobId || '').toString().trim();
const claimToken = (first.claimToken || context.claimToken || '').toString().trim();
if (!appStoreId || !runId || !jobId || !claimToken) return [];

const alerts = inputItems.map(({ json = {} }) => ({
  reviewId: (json.reviewId || json.ID || json.id || '').toString().trim(),
  rating: Number((json.rating || json.별점 || '0').toString().trim()) || 0,
  priority: (json.priority || json.긴급도 || '').toString().trim(),
  category: (json.category || json.유형 || '').toString().trim(),
  summary: (json.summary || json.요약 || '').toString().trim(),
  sentAt: new Date().toISOString(),
})).filter((alert) => alert.reviewId && alert.rating > 0);
if (alerts.length === 0) return [];

return [{ json: {
  runId,
  jobId,
  claimToken,
  payload: { runId, jobId, claimToken, appStoreId, country, alerts },
} }];`;

removeNodes([
  'Sign Claim Job Payload',
  'Sign Preflight Reviews Payload',
  'Sign Cluster Context',
  'Sign Upsert Payload',
  'Sign Cluster Upsert',
  'Sign Publish Payload',
  'Sign Parse Error Payload',
  'Sign Alert Events Payload',
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
]) {
  configureInternalHttpNode(name, '={{ $json.runId || $json.payload?.runId || $execution.id }}');
}

workflow.connections['Filter Duplicates'].main[0] = [
  { node: 'Prepare Cluster Context', type: 'main', index: 0 },
  { node: 'Check Critical Priority', type: 'main', index: 0 }
];
workflow.connections['Prepare Cluster Context'] = { main: [[{ node: 'Fetch Cluster Context', type: 'main', index: 0 }]] };
workflow.connections['Fetch Cluster Context'] = { main: [[{ node: 'Prepare Cluster Input', type: 'main', index: 0 }]] };
workflow.connections['Prepare Cluster Input'] = { main: [[{ node: 'Cluster Review Issues', type: 'main', index: 0 }]] };
workflow.connections['Google Gemini Chat Model'].ai_languageModel[0] = [
  { node: 'Basic LLM Chain', type: 'ai_languageModel', index: 0 },
  { node: 'Cluster Review Issues', type: 'ai_languageModel', index: 0 },
  { node: 'Consolidate Cluster Candidates', type: 'ai_languageModel', index: 0 }
];
workflow.connections['Cluster Review Issues'] = { main: [[{ node: 'Validate Cluster Output', type: 'main', index: 0 }]] };
workflow.connections['Validate Cluster Output'] = { main: [[{ node: 'Merge Cluster Batches', type: 'main', index: 0 }]] };
workflow.connections['Merge Cluster Batches'] = { main: [[{ node: 'Consolidate Cluster Candidates', type: 'main', index: 0 }]] };
workflow.connections['Consolidate Cluster Candidates'] = { main: [[{ node: 'Validate Consolidated Clusters', type: 'main', index: 0 }]] };
workflow.connections['Validate Consolidated Clusters'] = { main: [[{ node: 'Has Cluster Error?', type: 'main', index: 0 }]] };
workflow.connections['Has Cluster Error?'] = { main: [
  [{ node: 'Prepare Parse Error Payload', type: 'main', index: 0 }],
  [{ node: 'Prepare Upsert Payload', type: 'main', index: 0 }]
] };
workflow.connections['Upsert Reviews to BFF'] = { main: [[{ node: 'Prepare Cluster Upsert', type: 'main', index: 0 }]] };
workflow.connections['Prepare Cluster Upsert'] = { main: [[{ node: 'Upsert Clusters to BFF', type: 'main', index: 0 }]] };
workflow.connections['Upsert Clusters to BFF'] = { main: [[{ node: 'Prepare Publish Payload', type: 'main', index: 0 }]] };

workflow.connections['Prepare Claim Job Payload'] = { main: [[{ node: 'Claim Job from BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Preflight Reviews Payload'] = { main: [[{ node: 'Filter New Reviews via BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Upsert Payload'] = { main: [[{ node: 'Upsert Reviews to BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Publish Payload'] = { main: [[{ node: 'Notify Publish to BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Parse Error Payload'] = { main: [[{ node: 'Send Parse Error to BFF', type: 'main', index: 0 }]] };
workflow.connections['Prepare Alert Events Payload'] = { main: [[{ node: 'Send Alert Events to BFF', type: 'main', index: 0 }]] };

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
  'HTTP Request': [880, 0],
  'Prepare Preflight Reviews Payload': [1100, 0],
  'Filter New Reviews via BFF': [1320, 0],
  'Ensure New Reviews': [1540, 0],

  'Basic LLM Chain': [0, 260],
  'Parse JSON Response': [220, 260],
  'Has Parse Error?': [440, 260],
  'Filter Duplicates': [660, 260],
  'Prepare Cluster Context': [880, 260],
  'Fetch Cluster Context': [1100, 260],
  'Prepare Cluster Input': [1320, 260],
  'Cluster Review Issues': [1540, 260],
  'Validate Cluster Output': [1760, 260],
  'Google Gemini Chat Model': [990, 410],

  'Merge Cluster Batches': [0, 560],
  'Consolidate Cluster Candidates': [220, 560],
  'Validate Consolidated Clusters': [440, 560],
  'Has Cluster Error?': [660, 560],
  'Prepare Upsert Payload': [880, 560],
  'Upsert Reviews to BFF': [1100, 560],
  'Prepare Cluster Upsert': [1320, 560],
  'Upsert Clusters to BFF': [1540, 560],

  'Check Critical Priority': [0, 860],
  'Prepare Alert Events Payload': [220, 860],
  'Send Alert Events to BFF': [440, 860],
  'Prepare Parse Error Payload': [660, 860],
  'Send Parse Error to BFF': [880, 860],
  'Prepare Publish Payload': [1100, 860],
  'Notify Publish to BFF': [1320, 860],
};

for (const [name, position] of Object.entries(layout)) {
  const node = byName.get(name);
  if (!node) throw new Error(`Cannot position missing workflow node: ${name}`);
  node.position = position;
}

await writeFile(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
console.log('Updated n8n workflow with two-stage extraction and clustering.');
