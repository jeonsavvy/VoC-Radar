#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW_PATH = path.resolve(__dirname, '../n8n/workflow.supabase-only.json');
const COMPOSE_PATH = path.resolve(__dirname, '../n8n/compose.yaml');
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../n8n/.env.example');
const BUILDER_PATH = path.resolve(__dirname, './build-workflow-v2.mjs');
const INTERNAL_WORKER_PATH = path.resolve(__dirname, '../apps/worker/src/internal.ts');

const fail = (message) => {
  console.error(`[workflow-check] ${message}`);
  process.exit(1);
};

if (!fs.existsSync(WORKFLOW_PATH)) {
  fail(`workflow file not found: ${WORKFLOW_PATH}`);
}

let workflow;
try {
  workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
} catch (error) {
  fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
if (nodes.length === 0) {
  fail('workflow nodes are empty');
}

const portableWorkflowFields = new Set([
  'id', 'name', 'nodes', 'pinData', 'connections', 'active', 'settings', 'tags',
]);
const unexpectedWorkflowFields = Object.keys(workflow).filter((field) => !portableWorkflowFields.has(field));
if (unexpectedWorkflowFields.length > 0) {
  fail(`workflow export contains non-portable fields: ${unexpectedWorkflowFields.join(', ')}`);
}
if (workflow.id !== 'voc-radar-pipeline-v2') {
  fail('workflow export must use the deterministic portable workflow id');
}
if (workflow.pinData == null || typeof workflow.pinData !== 'object' || Object.keys(workflow.pinData).length > 0) {
  fail('workflow export must not contain pinned execution data');
}
if (!Array.isArray(workflow.tags) || workflow.tags.length > 0) {
  fail('workflow export must not contain instance tags');
}

const credentialBoundNodes = nodes.filter((node) => node?.credentials && Object.keys(node.credentials).length > 0);
if (credentialBoundNodes.length > 0) {
  fail(`workflow export must not contain credential bindings: ${credentialBoundNodes.map((node) => node.name || node.id).join(', ')}`);
}

const webhookNodesWithIds = nodes.filter((node) => Object.prototype.hasOwnProperty.call(node, 'webhookId'));
if (
  webhookNodesWithIds.length !== 1
  || webhookNodesWithIds[0].name !== 'Webhook Trigger (Queue Event)'
  || webhookNodesWithIds[0].webhookId !== 'voc-radar-queue-event'
) {
  fail('workflow export must use only the deterministic portable webhook id');
}

const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');
const envExample = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
const builderSource = fs.readFileSync(BUILDER_PATH, 'utf8');
const internalWorkerSource = fs.readFileSync(INTERNAL_WORKER_PATH, 'utf8');

const builderCheck = spawnSync(process.execPath, [BUILDER_PATH, '--check'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
});
if (builderCheck.status !== 0) {
  fail((builderCheck.stderr || builderCheck.stdout || 'workflow builder check failed').trim());
}

for (const requiredComposeLine of [
  'N8N_PIPELINE_TRIGGER_SECRET: ${N8N_PIPELINE_TRIGGER_SECRET:?N8N_PIPELINE_TRIGGER_SECRET is required}',
  'EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none"',
  'EXECUTIONS_DATA_SAVE_ON_ERROR: "all"',
  'EXECUTIONS_DATA_SAVE_ON_PROGRESS: "false"',
  'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "false"',
  'EXECUTIONS_DATA_PRUNE: "true"',
  'EXECUTIONS_DATA_MAX_AGE: "168"',
  'N8N_CONCURRENCY_PRODUCTION_LIMIT: ${N8N_CONCURRENCY_PRODUCTION_LIMIT:-1}',
  'VOC_FETCH_MAX_PAGES: ${VOC_FETCH_MAX_PAGES:-40}',
]) {
  if (!compose.includes(requiredComposeLine)) {
    fail(`compose is missing required execution/security setting: ${requiredComposeLine.split(':')[0]}`);
  }
}

if (!/^N8N_PIPELINE_TRIGGER_SECRET=<[^>]+>$/m.test(envExample)) {
  fail('.env.example must declare N8N_PIPELINE_TRIGGER_SECRET');
}
if (!/^N8N_CONCURRENCY_PRODUCTION_LIMIT=1$/m.test(envExample)) {
  fail('.env.example must bound production workflow concurrency to one execution');
}
if (!/^VOC_FETCH_MAX_PAGES=40$/m.test(envExample)) {
  fail('.env.example must keep review collection within the 40-page Worker boundary');
}

const scheduleTrigger = nodes.find((node) => node.name === 'Schedule Trigger (Queue Polling)');
const scheduleIntervals = scheduleTrigger?.parameters?.rule?.interval;
if (
  !Array.isArray(scheduleIntervals)
  || scheduleIntervals.length !== 1
  || scheduleIntervals[0]?.field !== 'minutes'
  || Number(scheduleIntervals[0]?.minutesInterval) !== 5
  || Object.hasOwn(scheduleTrigger?.parameters || {}, 'triggerTimes')
) {
  fail('queue recovery polling must use one unambiguous five-minute schedule');
}
if (
  !String(scheduleTrigger?.notes || '').includes('queued job')
  || !String(scheduleTrigger?.notes || '').includes('Production concurrency')
) {
  fail('queue recovery schedule must state its recovery and concurrency contract');
}

const fetchReviewsNode = nodes.find((node) => node.name === 'HTTP Request');
const fetchReviewsNotes = String(fetchReviewsNode?.notes || '');
for (const fragment of ['Worker BFF', '40페이지', 'terminal probe', '부분 데이터를 반환하지 않고']) {
  if (!fetchReviewsNotes.includes(fragment)) {
    fail(`review fetch notes are missing the current bounded BFF contract: ${fragment}`);
  }
}
if (/itunes\.apple\.com|limit=50|다른 앱으로 변경/i.test(fetchReviewsNotes)) {
  fail('review fetch notes must not retain the stale direct App Store contract');
}

if (
  workflow.settings?.saveDataSuccessExecution !== 'none' ||
  workflow.settings?.saveDataErrorExecution !== 'all' ||
  workflow.settings?.saveExecutionProgress !== false ||
  workflow.settings?.saveManualExecutions !== false
) {
  fail('workflow execution settings must disable success data and retain only failed execution data');
}

if (/\bconst\s+signCode\b|\$json\.(?:token|fetchToken)\b|\bfetchToken\b/.test(builderSource)) {
  fail('workflow builder must not materialize the internal API secret in item data');
}

const signNodes = nodes.filter((node) => String(node.name || '').startsWith('Sign '));
if (signNodes.length > 0) {
  fail(`obsolete signing nodes must be removed: ${signNodes.map((node) => node.name).join(', ')}`);
}

const secretItemNodes = nodes.filter((node) => {
  const jsCode = String(node?.parameters?.jsCode || '');
  return [
    /\$json\.(?:token|fetchToken)\b/,
    /\b(?:const|let|var)\s+(?:token|fetchToken)\b/,
    /(?:^|[,{}]\s*)(?:token|fetchToken)\s*:/m,
    /['"](?:token|fetchToken)['"]\s*:/,
  ].some((pattern) => pattern.test(jsCode));
});
if (secretItemNodes.length > 0) {
  fail(
    `internal API secret must not be stored in workflow items: ${secretItemNodes
      .map((node) => node.name || node.id)
      .join(', ')}`,
  );
}

const executeOnceNodes = nodes.filter((node) => node.executeOnce === true);
if (executeOnceNodes.length > 0) {
  const names = executeOnceNodes.map((node) => node.name || node.id || '(unknown)').join(', ');
  fail(`executeOnce=true is blocked in production workflow: ${names}`);
}

const pairedItemDependentNodes = nodes.filter((node) => {
  const jsCode = String(node?.parameters?.jsCode || '');
  return /\$\('[^']+'\)\.item\b|\$input\.item\b/.test(jsCode);
});
if (pairedItemDependentNodes.length > 0) {
  const names = pairedItemDependentNodes.map((node) => node.name || node.id || '(unknown)').join(', ');
  fail(`singleton workflow context must use .first(), not paired .item: ${names}`);
}

for (const node of nodes) {
  const jsCode = String(node?.parameters?.jsCode || '');
  if (!jsCode) continue;
  try {
    new Function(jsCode);
  } catch (error) {
    fail(`invalid Code node JavaScript in ${node.name || node.id}: ${error.message}`);
  }
}

const directSecretExpression = "={{ ($env.PIPELINE_WEBHOOK_SECRET || '').toString().trim() }}";
const internalHttpNodes = nodes.filter(
  (node) =>
    node.type === 'n8n-nodes-base.httpRequest' &&
    String(node?.parameters?.url || '').includes('/api/internal/pipeline/'),
);
if (internalHttpNodes.length === 0) {
  fail('internal pipeline HTTP nodes are missing');
}

for (const node of internalHttpNodes) {
  const headers = node.parameters?.headerParameters?.parameters || [];
  const headerByName = new Map(
    headers.map((header) => [(header.name || '').toString().toLowerCase(), String(header.value || '')]),
  );
  if (headerByName.get('x-voc-token') !== directSecretExpression) {
    fail(`${node.name} must read PIPELINE_WEBHOOK_SECRET directly in the HTTP header`);
  }
  if (headerByName.has('x-voc-timestamp') || headerByName.has('x-voc-signature')) {
    fail(`${node.name} must not materialize signing metadata in workflow items`);
  }
  if (!headerByName.has('x-idempotency-key')) {
    fail(`${node.name} must send an idempotency key`);
  }
  if (node.retryOnFail !== true || node.maxTries !== 3) {
    fail(`${node.name} retryOnFail/maxTries must be configured at node top-level`);
  }
  if (
    Object.prototype.hasOwnProperty.call(node.parameters?.options || {}, 'retryOnFail') ||
    Object.prototype.hasOwnProperty.call(node.parameters?.options || {}, 'maxTries')
  ) {
    fail(`${node.name} retry settings must not be nested under parameters.options`);
  }
  if (
    node.continueOnFail === true ||
    String(node.onError || '').startsWith('continue') ||
    node.parameters?.options?.response?.response?.neverError === true
  ) {
    fail(`${node.name} must stop the execution on job_claim_lost or any HTTP error`);
  }
}

const claimHttpNode = nodes.find((node) => node.name === 'Claim Job from BFF');
const claimHeaders = claimHttpNode?.parameters?.headerParameters?.parameters || [];
const claimIdempotencyHeader = claimHeaders.find(
  (header) => (header.name || '').toString().toLowerCase() === 'x-idempotency-key',
);
if (String(claimIdempotencyHeader?.value || '') !== '={{ $json.claimKey }}') {
  fail('claim request idempotency header must use claimKey');
}

const triggerValidationCode = String(
  nodes.find((node) => node.name === 'Validate Trigger Secret')?.parameters?.jsCode || '',
);
if (
  !triggerValidationCode.includes('$env.N8N_PIPELINE_TRIGGER_SECRET') ||
  !/if\s*\(!expected\)\s*{\s*throw\b/.test(triggerValidationCode) ||
  !/if\s*\(!provided\s*\|\|\s*provided\s*!==\s*expected\)\s*{\s*throw\b/.test(
    triggerValidationCode,
  ) ||
  /secretCheck\s*:\s*['"]skipped['"]/.test(triggerValidationCode)
) {
  fail('Validate Trigger Secret must fail closed for missing and mismatched secrets');
}

const webhookOutputs = workflow.connections?.['Webhook Trigger (Queue Event)']?.main?.[0] || [];
if (
  webhookOutputs.length !== 1 ||
  webhookOutputs[0]?.node !== 'Validate Trigger Secret'
) {
  fail('webhook trigger must pass only through Validate Trigger Secret before claim');
}
const validatedTriggerOutputs = workflow.connections?.['Validate Trigger Secret']?.main?.[0] || [];
if (
  validatedTriggerOutputs.length !== 1 ||
  validatedTriggerOutputs[0]?.node !== 'Prepare Claim Job Payload'
) {
  fail('validated webhook trigger must enter the claim path without a bypass');
}

const claimPreparationCode = String(
  nodes.find((node) => node.name === 'Prepare Claim Job Payload')?.parameters?.jsCode || '',
);
if (
  !claimPreparationCode.includes('$execution.id') ||
  !claimPreparationCode.includes('claimKey') ||
  !/payload\s*:\s*{\s*claimKey\s*}/.test(claimPreparationCode)
) {
  fail('claim payload must use $execution.id as claimKey');
}

const runContextCode = String(nodes.find((node) => node.name === 'Prepare Run Context')?.parameters?.jsCode || '');
for (const requiredFragment of [
  "status !== 'running'",
  'data.claimToken',
  'data.leaseExpiresAt',
  'data.attemptCount',
  "'RUN_' + jobId + '_' + attemptCount",
]) {
  if (!runContextCode.includes(requiredFragment)) {
    fail(`Prepare Run Context is missing claim contract fragment: ${requiredFragment}`);
  }
}
if (/RUN_.*Date\.now/.test(runContextCode)) {
  fail('runId must be deterministic for the claimed job attempt');
}
if (
  !/if\s*\(!jobId\s*\|\|\s*status\s*!==\s*'running'\)\s*{[\s\S]*?hasClaim\s*:\s*false[\s\S]*?}/.test(
    runContextCode,
  )
) {
  fail('Prepare Run Context must emit an explicit false claim marker for empty responses');
}
if (!/hasClaim\s*:\s*true/.test(runContextCode)) {
  fail('Prepare Run Context must mark valid claimed jobs before the pipeline branch');
}
const activeClaimGate = nodes.find((node) => node.name === 'Has Active Claim?');
if (activeClaimGate?.type !== 'n8n-nodes-base.if') {
  fail('workflow must include an explicit active-claim gate');
}
const activeClaimConditions = activeClaimGate?.parameters?.conditions?.conditions || [];
const activeClaimCondition = activeClaimConditions[0];
if (
  activeClaimGate?.typeVersion !== 2
  || activeClaimConditions.length !== 1
  || activeClaimCondition?.leftValue !== "={{ $json.hasClaim === true ? 'yes' : 'no' }}"
  || activeClaimCondition?.rightValue !== 'yes'
  || activeClaimCondition?.operator?.type !== 'string'
  || activeClaimCondition?.operator?.operation !== 'equals'
) {
  fail('active-claim gate must preserve its boolean polarity and strict string comparison');
}
const runContextTargets = workflow.connections?.['Prepare Run Context']?.main?.[0] || [];
const claimedTargets = workflow.connections?.['Has Active Claim?']?.main?.[0] || [];
const emptyClaimTargets = workflow.connections?.['Has Active Claim?']?.main?.[1] || [];
if (
  runContextTargets.length !== 1
  || runContextTargets[0]?.node !== 'Has Active Claim?'
  || claimedTargets.length !== 1
  || claimedTargets[0]?.node !== 'HTTP Request'
  || emptyClaimTargets.length !== 0
) {
  fail('active-claim gate must continue only claimed jobs and terminate the empty queue branch');
}
const fetchPayloadBlock = runContextCode.match(/const\s+fetchPayload\s*=\s*{([\s\S]*?)};/)?.[1] || '';
for (const field of ['jobId', 'claimToken', 'runId']) {
  if (!new RegExp(`\\b${field}\\b`).test(fetchPayloadBlock)) {
    fail(`fetch payload must carry ${field}`);
  }
}
if (
  !runContextCode.includes("$env.VOC_FETCH_MAX_PAGES || '40'")
  || !runContextCode.includes('Math.min(Math.max(Math.floor(parsedMaxPages), 1), 40)')
) {
  fail('Prepare Run Context must clamp review collection to the 40-page Worker boundary');
}
const preparePreflightCode = String(
  nodes.find((node) => node.name === 'Prepare Preflight Reviews Payload')?.parameters?.jsCode || '',
);
if (
  !preparePreflightCode.includes('responseData.complete !== true')
  || !preparePreflightCode.includes('responseData.truncated === true')
) {
  fail('review preflight must reject every collection that did not prove the requested window complete');
}

for (const nodeName of [
  'Prepare Run Context',
  'Prepare Preflight Reviews Payload',
  'Prepare Cluster Context',
  'Prepare Upsert Payload',
  'Prepare Cluster Upsert',
  'Prepare Publish Payload',
  'Prepare Parse Error Payload',
  'Prepare Alert Events Payload',
]) {
  const code = String(nodes.find((node) => node.name === nodeName)?.parameters?.jsCode || '');
  for (const field of ['jobId', 'claimToken', 'runId']) {
    if (!code.includes(field)) {
      fail(`${nodeName} must propagate ${field}`);
    }
  }
}

for (const nodeName of [
  'Parse JSON Response',
  'Filter Duplicates',
  'Validate Cluster Output',
  'Merge Cluster Batches',
  'Validate Consolidated Clusters',
]) {
  const code = String(nodes.find((node) => node.name === nodeName)?.parameters?.jsCode || '');
  if (!code.includes('claimToken')) {
    fail(`${nodeName} must retain claimToken across success and parse-error paths`);
  }
}

const nodeNames = new Set(nodes.map((node) => node.name));
for (const [sourceName, connectionGroups] of Object.entries(workflow.connections || {})) {
  if (!nodeNames.has(sourceName)) fail(`connection source is missing: ${sourceName}`);
  for (const outputs of Object.values(connectionGroups || {})) {
    for (const output of outputs || []) {
      for (const connection of output || []) {
        if (!nodeNames.has(connection.node)) {
          fail(`connection target is missing: ${sourceName} -> ${connection.node}`);
        }
      }
    }
  }
}

const mainTargets = (sourceName, outputIndex = 0) =>
  (workflow.connections?.[sourceName]?.main?.[outputIndex] || []).map(
    (connection) => connection.node,
  );
const requireOnlyMainTargets = (sourceName, outputIndex, expectedTargets, message) => {
  const actualTargets = mainTargets(sourceName, outputIndex);
  if (
    actualTargets.length !== expectedTargets.length ||
    actualTargets.some((target, index) => target !== expectedTargets[index])
  ) {
    fail(`${message}: ${sourceName}[${outputIndex}] -> ${actualTargets.join(', ') || '(none)'}`);
  }
};
const mainSources = (targetName) => {
  const sources = [];
  for (const [sourceName, connectionGroups] of Object.entries(workflow.connections || {})) {
    for (const output of connectionGroups?.main || []) {
      if ((output || []).some((connection) => connection.node === targetName)) sources.push(sourceName);
    }
  }
  return sources.sort();
};
const requireOnlyMainSources = (targetName, expectedSources, message) => {
  const actualSources = mainSources(targetName);
  const sortedExpected = [...expectedSources].sort();
  if (
    actualSources.length !== sortedExpected.length ||
    actualSources.some((source, index) => source !== sortedExpected[index])
  ) {
    fail(`${message}: ${actualSources.join(', ') || '(none)'} -> ${targetName}`);
  }
};
requireOnlyMainSources(
  'Has Active Claim?',
  ['Prepare Run Context'],
  'only normalized claim responses may enter the active-claim gate',
);
requireOnlyMainSources(
  'HTTP Request',
  ['Has Active Claim?'],
  'review collection must not bypass the active-claim gate',
);
const hasMainPath = (sourceName, targetName) => {
  const pending = [sourceName];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === targetName) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const outputs = workflow.connections?.[current]?.main || [];
    for (const output of outputs) {
      for (const connection of output || []) pending.push(connection.node);
    }
  }
  return false;
};

for (const contract of [
  {
    input: 'Ensure New Reviews',
    loop: 'Loop Extraction Batches',
    llm: 'Basic LLM Chain',
    checkpoint: 'Checkpoint Extraction Lease',
    renew: 'Renew Extraction Lease',
    restore: 'Restore Extraction Result',
    done: 'Parse JSON Response',
    stage: 'extracting',
  },
  {
    input: 'Prepare Cluster Input',
    loop: 'Loop Cluster Batches',
    llm: 'Cluster Review Issues',
    checkpoint: 'Checkpoint Cluster Lease',
    renew: 'Renew Cluster Lease',
    restore: 'Restore Cluster Result',
    done: 'Validate Cluster Output',
    stage: 'clustering',
  },
]) {
  const loopNode = nodes.find((node) => node.name === contract.loop);
  if (
    loopNode?.type !== 'n8n-nodes-base.splitInBatches' ||
    loopNode?.typeVersion !== 3 ||
    loopNode?.parameters?.batchSize !== 1 ||
    loopNode?.parameters?.options?.reset === true
  ) {
    fail(`${contract.loop} must process exactly one model batch per fenced iteration`);
  }

  const llm = nodes.find((node) => node.name === contract.llm);
  if (llm?.alwaysOutputData !== true) {
    fail(`${contract.llm} must always emit one loop result, including model failures`);
  }

  const checkpointCode = String(
    nodes.find((node) => node.name === contract.checkpoint)?.parameters?.jsCode || '',
  );
  for (const fragment of [
    'resultItems',
    'resultItems.length !== 1',
    'jobId',
    'claimToken',
    'runId',
    `stage: '${contract.stage}'`,
  ]) {
    if (!checkpointCode.includes(fragment)) {
      fail(`${contract.checkpoint} is missing fenced checkpoint fragment: ${fragment}`);
    }
  }

  const renew = nodes.find((node) => node.name === contract.renew);
  if (
    !String(renew?.parameters?.url || '').includes('/api/internal/pipeline/heartbeat') ||
    renew?.parameters?.jsonBody !== '={{ $json.heartbeatPayload }}'
  ) {
    fail(`${contract.renew} must renew the captured claim through the heartbeat endpoint`);
  }

  const restoreCode = String(
    nodes.find((node) => node.name === contract.restore)?.parameters?.jsCode || '',
  );
  if (
    !restoreCode.includes(`$('${contract.checkpoint}').first(0, $runIndex)`) ||
    !restoreCode.includes("heartbeat.status || ''") ||
    !restoreCode.includes(`heartbeat.stage !== '${contract.stage}'`) ||
    !restoreCode.includes('resultItems.map')
  ) {
    fail(`${contract.restore} must release results only after the matching heartbeat succeeds`);
  }

  requireOnlyMainTargets(contract.input, 0, [contract.loop], 'model batches must enter the fenced loop');
  requireOnlyMainTargets(contract.loop, 0, [contract.done], 'only completed loop results may leave the batch loop');
  requireOnlyMainTargets(contract.loop, 1, [contract.llm], 'each loop iteration must execute one model batch');
  requireOnlyMainTargets(contract.llm, 0, [contract.checkpoint], 'model output must enter the lease checkpoint');
  requireOnlyMainTargets(contract.checkpoint, 0, [contract.renew], 'checkpoint output must renew the fenced claim');
  requireOnlyMainTargets(contract.renew, 0, [contract.restore], 'heartbeat success must enter result restoration');
  requireOnlyMainTargets(contract.restore, 0, [contract.loop], 'restored results must close the batch loop');
  requireOnlyMainSources(contract.llm, [contract.loop], 'model batches must not bypass the fenced loop');
  requireOnlyMainSources(contract.done, [contract.loop], 'downstream validation must receive only completed loop output');
}

const functionSource = (name) => {
  const start = internalWorkerSource.indexOf(`async function ${name}`);
  if (start < 0) return '';
  const next = internalWorkerSource.indexOf('\nasync function ', start + 1);
  return internalWorkerSource.slice(start, next < 0 ? undefined : next);
};
const scopedReviewLookupSource = functionSource('fetchScopedReviewRows');
const filterNewReviewsSource = functionSource('handleInternalFilterNewReviews');
const clusterContextSource = functionSource('handleInternalClusterContext');
if (
  !/const beforeLookup = await renewPipelineJobClaim\(env, claim, heartbeatStage\);[\s\S]*?get_pipeline_review_scope[\s\S]*?const afterLookup = await renewPipelineJobClaim\(env, claim, heartbeatStage\)/.test(
    scopedReviewLookupSource,
  ) ||
  !/const guardedJob = await renewPipelineJobClaim\(env, claim, 'extracting'\)/.test(
    filterNewReviewsSource,
  ) ||
  !/fetchScopedReviewRows<[\s\S]*?'extracting',[\s\S]*?true,[\s\S]*?\)/.test(filterNewReviewsSource)
) {
  fail('filter-new-reviews must renew the extraction lease immediately before the first model loop');
}
if (
  !/const activeClaim = await renewPipelineJobClaim\(env, claim, 'clustering'\);[\s\S]*?get_pipeline_cluster_context/.test(
    clusterContextSource,
  )
) {
  fail('cluster-context must renew the clustering lease before the first cluster model loop');
}
requireOnlyMainTargets(
  'Filter New Reviews via BFF',
  0,
  ['Ensure New Reviews'],
  'the first extraction model batch must follow the preflight lease renewal',
);
requireOnlyMainTargets(
  'Fetch Cluster Context',
  0,
  ['Prepare Cluster Input'],
  'the first cluster model batch must follow the cluster-context lease renewal',
);

const ensureNewReviewsCode = String(
  nodes.find((node) => node.name === 'Ensure New Reviews')?.parameters?.jsCode || '',
);
const prepareClusterInputCode = String(
  nodes.find((node) => node.name === 'Prepare Cluster Input')?.parameters?.jsCode || '',
);
const validateClusterOutputCode = String(
  nodes.find((node) => node.name === 'Validate Cluster Output')?.parameters?.jsCode || '',
);
if (!ensureNewReviewsCode.includes('Math.min(Math.max(Math.floor(parsedBatch), 1), 50)')) {
  fail('extraction model input must remain bounded to 50 reviews');
}
if (!prepareClusterInputCode.includes('Math.min(Math.max(Math.floor(parsedBatchLimit), 10), 40)')) {
  fail('cluster model input must remain bounded to 40 reviews');
}
for (const fragment of [
  '$json.data.length > 10000',
  'existingClusters.length <= 100',
  'selectedEntries.length >= 160',
  'measuredContextBytes > 49152',
  'new TextEncoder().encode(value).length',
  "text.match(/[가-힣]+|[a-z]+|[0-9]+/g)",
  'categoryEntries[0]',
  'candidate.lexicalScore > 0',
  'right.normalized.reviewCount - left.normalized.reviewCount',
  'right.lastSeenMs - left.lastSeenMs',
  'existingClusters: selectedClusters',
  'existingClusterTotalCount: existingClusters.length',
  'existingClusterContextBytes: measuredContextBytes',
  'completeContextBytes <= 49152',
  'queueEntry(primaryEntries, categoryEntries[0])',
  'queueEntry(primaryEntries, rankedByRelevance.find((entry) => entry.lexicalScore > 0))',
  "throw new Error('invalid existing cluster row at index '",
  "throw new Error('invalid existing cluster row exceeds the context byte budget')",
]) {
  if (!prepareClusterInputCode.includes(fragment)) {
    fail(`existing cluster context selection is missing a bound or relevance invariant: ${fragment}`);
  }
}
if (
  prepareClusterInputCode.includes('reviewItems: batchReviews,\n  existingClusters,') ||
  !String(nodes.find((node) => node.name === 'Prepare Cluster Input')?.notes || '').includes(
    '최대 160개, 49152 UTF-8 bytes',
  )
) {
  fail('cluster batches must contain only bounded selected existing-cluster context');
}
if (
  !validateClusterOutputCode.includes('llmItems.length !== contexts.length') ||
  !validateClusterOutputCode.includes('cluster batch count mismatch: expected ')
) {
  fail('cluster model output must match the global batch cardinality exactly');
}
if (
  !internalWorkerSource.includes('MAX_FETCH_REVIEW_CAP') ||
  !internalWorkerSource.includes('clampLimit(String(body?.limit ?? MAX_FETCH_REVIEW_CAP)')
) {
  fail('the upstream review set must remain bounded by MAX_FETCH_REVIEW_CAP');
}
if (!compose.includes('image: docker.n8n.io/n8nio/n8n:2.30.8')) {
  fail('the verified Gemini timeout contract is pinned to n8n 2.30.8');
}
const leaseContractText =
  'n8n 2.30.8 Gemini has no request timeout; one bounded call must finish within the 15-minute claim lease.';
for (const nodeName of [
  'Basic LLM Chain',
  'Cluster Review Issues',
  'Consolidate Cluster Candidates',
]) {
  const node = nodes.find((candidate) => candidate.name === nodeName);
  if (!String(node?.notes || '').includes(leaseContractText)) {
    fail(`${nodeName} must state the bounded single-call lease contract`);
  }
}
const leaseGeminiNode = nodes.find((node) => node.name === 'Google Gemini Chat Model');
if (/timeout/i.test(JSON.stringify(leaseGeminiNode?.parameters?.options || {}))) {
  fail('Gemini lease safety must not rely on an unsupported n8n 2.30.8 timeout option');
}
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
for (const [nodeName, expectedTimeout] of internalHttpTimeouts) {
  const timeout = Number(nodes.find((node) => node.name === nodeName)?.parameters?.options?.timeout);
  if (timeout !== expectedTimeout) {
    fail(`${nodeName} must use the bounded Worker endpoint timeout ${expectedTimeout}`);
  }
}
for (const fragment of [
  'const FETCH_REVIEWS_DEADLINE_MS = 270_000',
  'const APPLE_REVIEW_PAGE_TIMEOUT_MS = 5_000',
  "redirect: 'manual'",
  "retries: 0",
  "'review_scope_incomplete'",
  'complete: true',
  'truncated: false',
  'pipelineSupabaseRequest',
]) {
  if (!internalWorkerSource.includes(fragment)) {
    fail(`Worker review/timeout contract is missing: ${fragment}`);
  }
}

const prepareConsolidation = nodes.find((node) => node.name === 'Prepare Consolidation Batches');
const prepareConsolidationCode = String(prepareConsolidation?.parameters?.jsCode || '');
const consolidateCandidates = nodes.find((node) => node.name === 'Consolidate Cluster Candidates');
const validateConsolidationCode = String(
  nodes.find((node) => node.name === 'Validate Consolidated Clusters')?.parameters?.jsCode || '',
);
for (const fragment of [
  'sourceClusters.length > 10000',
  'next.length > 48',
  'utf8Length(nextPrompt) > 65536',
  'new TextEncoder().encode(value).length',
  "title.length > 120",
  "summary.length > 400",
  'candidateCount: batch.length',
  'promptBytes',
]) {
  if (!prepareConsolidationCode.includes(fragment)) {
    fail(`candidate batching is missing a hard count, UTF-8 byte, or field bound: ${fragment}`);
  }
}
if (
  consolidateCandidates?.parameters?.text !== '={{ $json.prompt }}' ||
  !String(consolidateCandidates?.notes || '').includes('후보 최대 48개') ||
  !String(consolidateCandidates?.notes || '').includes('65536 UTF-8 bytes')
) {
  fail('candidate consolidation must consume only the pre-measured bounded prompt');
}
for (const fragment of [
  'llmItems.length !== contexts.length',
  'expectedCandidateIds.length !== sourceClusters.length',
  'assignedCandidates.size !== sourceClusters.length',
  'not every consolidation candidate was assigned exactly once',
  'canonicalKey must come from its source candidates',
  'title.length > 120',
  'summary.length > 400',
  'actionHint.length > 240',
]) {
  if (!validateConsolidationCode.includes(fragment)) {
    fail(`candidate consolidation validation is missing a global invariant: ${fragment}`);
  }
}

const consolidationHeartbeatContract = {
  input: 'Has Consolidation Input Error?',
  loop: 'Loop Consolidation Batches',
  llm: 'Consolidate Cluster Candidates',
  checkpoint: 'Checkpoint Consolidation Lease',
  renew: 'Renew Consolidation Lease',
  restore: 'Restore Consolidation Result',
  done: 'Validate Consolidated Clusters',
};
const consolidationLoop = nodes.find((node) => node.name === consolidationHeartbeatContract.loop);
const consolidationCheckpointCode = String(
  nodes.find((node) => node.name === consolidationHeartbeatContract.checkpoint)?.parameters?.jsCode || '',
);
const consolidationRestoreCode = String(
  nodes.find((node) => node.name === consolidationHeartbeatContract.restore)?.parameters?.jsCode || '',
);
if (
  consolidationLoop?.type !== 'n8n-nodes-base.splitInBatches' ||
  consolidationLoop?.typeVersion !== 3 ||
  consolidationLoop?.parameters?.batchSize !== 1 ||
  !consolidationCheckpointCode.includes("stage: 'clustering'") ||
  !consolidationCheckpointCode.includes('resultItems.length !== 1') ||
  !consolidationRestoreCode.includes("heartbeat.stage !== 'clustering'") ||
  !consolidationRestoreCode.includes(
    "$('Checkpoint Consolidation Lease').first(0, $runIndex)",
  )
) {
  fail('every bounded candidate consolidation batch must run in a one-at-a-time fenced loop');
}
requireOnlyMainTargets(
  consolidationHeartbeatContract.input,
  1,
  [consolidationHeartbeatContract.loop],
  'validated candidate batches must enter the consolidation loop',
);
requireOnlyMainTargets(
  consolidationHeartbeatContract.loop,
  0,
  [consolidationHeartbeatContract.done],
  'only accumulated fenced candidate results may leave the consolidation loop',
);
requireOnlyMainTargets(
  consolidationHeartbeatContract.loop,
  1,
  [consolidationHeartbeatContract.llm],
  'each bounded candidate batch must execute one model call',
);
requireOnlyMainTargets(
  consolidationHeartbeatContract.llm,
  0,
  [consolidationHeartbeatContract.checkpoint],
  'candidate consolidation output must enter the lease checkpoint',
);
requireOnlyMainTargets(
  consolidationHeartbeatContract.checkpoint,
  0,
  [consolidationHeartbeatContract.renew],
  'candidate consolidation checkpoint must renew the fenced claim',
);
requireOnlyMainTargets(
  consolidationHeartbeatContract.renew,
  0,
  [consolidationHeartbeatContract.restore],
  'candidate consolidation heartbeat must gate result restoration',
);
requireOnlyMainTargets(
  consolidationHeartbeatContract.restore,
  0,
  [consolidationHeartbeatContract.loop],
  'only the current claimant may return candidate output to the loop',
);
requireOnlyMainSources(
  'Validate Consolidated Clusters',
  [consolidationHeartbeatContract.loop],
  'candidate validation must not bypass lease fencing',
);

const extractionGate = nodes.find((node) => node.name === 'Gate Extraction Batches');
const extractionGateCode = String(extractionGate?.parameters?.jsCode || '');
const parseResponseCode = String(
  nodes.find((node) => node.name === 'Parse JSON Response')?.parameters?.jsCode || '',
);
if (
  !parseResponseCode.includes('llmItems.length !== contextItems.length') ||
  !parseResponseCode.includes('extraction batch count mismatch: expected ') ||
  !parseResponseCode.includes("'batch_count'")
) {
  fail('Parse JSON Response must turn missing or extra LLM batches into a parse error');
}
if (
  extractionGate?.type !== 'n8n-nodes-base.code' ||
  extractionGate?.parameters?.mode !== 'runOnceForAllItems' ||
  !extractionGateCode.includes("startsWith('PARSE_ERROR_')") ||
  !extractionGateCode.includes('parseErrors[0].json') ||
  !extractionGateCode.includes('return items;')
) {
  fail('Gate Extraction Batches must discard successful subsets and emit one parse error globally');
}
const parseErrorCondition = nodes.find((node) => node.name === 'Has Parse Error?')
  ?.parameters?.conditions?.conditions?.[0];
if (
  !String(parseErrorCondition?.leftValue || '').includes("startsWith('PARSE_ERROR_')") ||
  parseErrorCondition?.rightValue !== 'yes' ||
  parseErrorCondition?.operator?.operation !== 'equals'
) {
  fail('Has Parse Error? must route the global PARSE_ERROR item through its true output');
}
requireOnlyMainTargets(
  'Parse JSON Response',
  0,
  ['Gate Extraction Batches'],
  'Stage 1 parsing must enter the global extraction gate',
);
requireOnlyMainTargets(
  'Gate Extraction Batches',
  0,
  ['Has Parse Error?'],
  'the global extraction gate must be the only input to the parse-error branch',
);
requireOnlyMainSources(
  'Has Parse Error?',
  ['Gate Extraction Batches'],
  'the parse-error IF must not accept a bypass around the global extraction gate',
);
requireOnlyMainTargets(
  'Has Parse Error?',
  0,
  ['Prepare Parse Error Payload'],
  'parse errors must terminate through error persistence',
);
requireOnlyMainTargets(
  'Has Parse Error?',
  1,
  ['Filter Duplicates'],
  'only globally successful Stage 1 output may enter persistence',
);
requireOnlyMainSources(
  'Filter Duplicates',
  ['Has Parse Error?'],
  'Stage 1 persistence must not accept a bypass around the global success output',
);

if (nodes.some((node) => node.name === 'Check Critical Priority')) {
  fail('per-item Critical branching is obsolete; alerts must use the serialized global gate');
}
const criticalAlertGate = nodes.find((node) => node.name === 'Has Critical Alerts?');
const criticalAlertCondition = criticalAlertGate?.parameters?.conditions?.conditions?.[0];
if (
  criticalAlertGate?.type !== 'n8n-nodes-base.if' ||
  criticalAlertCondition?.leftValue !==
    "={{ $json.hasCriticalAlerts === true ? 'yes' : 'no' }}" ||
  criticalAlertCondition?.rightValue !== 'yes' ||
  criticalAlertCondition?.operator?.operation !== 'equals'
) {
  fail('Has Critical Alerts? must route hasCriticalAlerts=true through its HTTP output');
}
const prepareAlerts = nodes.find((node) => node.name === 'Prepare Alert Events Payload');
const prepareAlertsCode = String(prepareAlerts?.parameters?.jsCode || '');
const prepareClusterContextCode = String(
  nodes.find((node) => node.name === 'Prepare Cluster Context')?.parameters?.jsCode || '',
);
if (
  prepareAlerts?.parameters?.mode !== 'runOnceForAllItems' ||
  !prepareAlertsCode.includes('hasCriticalAlerts: alerts.length > 0') ||
  !prepareAlertsCode.includes("normalized !== 'Normal'") ||
  !prepareAlertsCode.includes(
    "rating <= 1 && (category === '버그 및 성능' || category === '계정 및 결제')",
  ) ||
  !prepareAlertsCode.includes("alert.priority === 'Critical'") ||
  prepareAlertsCode.includes('reviewItems')
) {
  fail('Prepare Alert Events Payload must use canonical Critical priority without copying all reviews');
}
if (
  nodes.some((node) => node.name === 'Restore Reviews After Alerts') ||
  !prepareClusterContextCode.includes("$('Filter Duplicates').all()") ||
  prepareClusterContextCode.includes('$input.all()')
) {
  fail('cluster context must reuse Filter Duplicates output after the alert barrier without fan-out');
}
requireOnlyMainTargets(
  'Filter Duplicates',
  0,
  ['Prepare Alert Events Payload'],
  'all reviews must enter the alert gate before clustering',
);
requireOnlyMainTargets(
  'Prepare Alert Events Payload',
  0,
  ['Has Critical Alerts?'],
  'the alert aggregate must enter the Critical gate',
);
requireOnlyMainTargets(
  'Has Critical Alerts?',
  0,
  ['Send Alert Events to BFF'],
  'Critical alerts must be persisted before analysis continues',
);
requireOnlyMainTargets(
  'Has Critical Alerts?',
  1,
  ['Prepare Cluster Context'],
  'runs without Critical alerts must continue to clustering without an HTTP call',
);
requireOnlyMainTargets(
  'Send Alert Events to BFF',
  0,
  ['Prepare Cluster Context'],
  'Critical alert persistence must complete before clustering',
);
requireOnlyMainSources(
  'Prepare Cluster Context',
  ['Has Critical Alerts?', 'Send Alert Events to BFF'],
  'clustering must accept only the mutually exclusive serialized alert-gate outputs',
);
requireOnlyMainSources(
  'Send Alert Events to BFF',
  ['Has Critical Alerts?'],
  'alert persistence must be reachable only from the Critical output',
);
if (!hasMainPath('Send Alert Events to BFF', 'Notify Publish to BFF')) {
  fail('the Critical path must reach publish only after alert persistence');
}
requireOnlyMainSources(
  'Prepare Publish Payload',
  ['Upsert Clusters to BFF'],
  'publish preparation must accept only persisted cluster output',
);
requireOnlyMainSources(
  'Notify Publish to BFF',
  ['Prepare Publish Payload'],
  'publish notification must not have a bypass',
);

const llmNode = nodes.find((node) => node.name === 'Basic LLM Chain');
if (!llmNode) {
  fail('required node not found: Basic LLM Chain');
}

if (llmNode.executeOnce !== false) {
  fail('Basic LLM Chain.executeOnce must be false to process all review batches');
}

const modelVersionResolver =
  "(($env.VOC_MODEL_VERSION || 'gemini-3-flash-preview').toString().trim().replace(/^models\\//, '') || 'gemini-3-flash-preview')";
const expectedModelName = `={{ 'models/' + ${modelVersionResolver} }}`;
const geminiModel = nodes.find((node) => node.name === 'Google Gemini Chat Model');
if (geminiModel?.parameters?.modelName !== expectedModelName) {
  fail('Google Gemini Chat Model must resolve its model from VOC_MODEL_VERSION');
}
const persistedModelVersionCode = String(
  nodes.find((node) => node.name === 'Prepare Upsert Payload')?.parameters?.jsCode || '',
);
if (!persistedModelVersionCode.includes(`const modelVersion = ${modelVersionResolver};`)) {
  fail('persisted modelVersion must use the same resolver as the Gemini model node');
}
if (
  /\brawSource\s*:/.test(persistedModelVersionCode) ||
  (persistedModelVersionCode.match(/\bcontent\s*:/g) || []).length !== 1
) {
  fail('review persistence payload must not duplicate review fields inside rawSource');
}

for (const requiredName of [
  'Cluster Review Issues',
  'Validate Cluster Output',
  'Merge Cluster Batches',
  'Prepare Consolidation Batches',
  'Has Consolidation Input Error?',
  'Loop Consolidation Batches',
  'Consolidate Cluster Candidates',
  'Validate Consolidated Clusters',
  'Fetch Cluster Context',
  'Upsert Clusters to BFF',
]) {
  if (!nodes.some((node) => node.name === requiredName)) {
    fail(`required V2 node not found: ${requiredName}`);
  }
}

const clusterNode = nodes.find((node) => node.name === 'Cluster Review Issues');
if (clusterNode.executeOnce !== false) {
  fail('Cluster Review Issues.executeOnce must be false');
}

for (const [nodeName, codePath] of [
  ['Merge Cluster Batches', '../n8n/code/merge-cluster-batches.js'],
]) {
  const node = nodes.find((candidate) => candidate.name === nodeName);
  const expectedCode = fs.readFileSync(path.resolve(__dirname, codePath), 'utf8').trim();
  if (String(node?.parameters?.jsCode || '').trim() !== expectedCode) {
    fail(`${nodeName} is stale; run node scripts/build-workflow-v2.mjs`);
  }
}

const validationOutputs = workflow.connections?.['Validate Cluster Output']?.main?.[0] || [];
if (!validationOutputs.some((connection) => connection.node === 'Merge Cluster Batches')) {
  fail('validated cluster batches must be merged before the error/publish gate');
}

const mergeOutputs = workflow.connections?.['Merge Cluster Batches']?.main?.[0] || [];
if (!mergeOutputs.some((connection) => connection.node === 'Prepare Consolidation Batches')) {
  fail('merged cluster output must pass through bounded candidate preparation');
}

const consolidationOutputs = workflow.connections?.['Restore Consolidation Result']?.main?.[0] || [];
if (!consolidationOutputs.some((connection) => connection.node === 'Loop Consolidation Batches')) {
  fail('every fenced candidate consolidation output must return to its accumulator loop');
}

const consolidatedValidationOutputs = workflow.connections?.['Validate Consolidated Clusters']?.main?.[0] || [];
if (!consolidatedValidationOutputs.some((connection) => connection.node === 'Has Cluster Error?')) {
  fail('validated consolidated output must pass through the error gate');
}

const clusterUpsert = nodes.find((node) => node.name === 'Upsert Clusters to BFF');
if (!String(clusterUpsert?.parameters?.url || '').includes('/api/internal/pipeline/upsert-clusters')) {
  fail('cluster upsert endpoint is missing from workflow');
}

const prepareUpsert = nodes.find((node) => node.name === 'Prepare Upsert Payload');
const prepareClusterUpsert = nodes.find((node) => node.name === 'Prepare Cluster Upsert');
const prepareClusterContext = nodes.find((node) => node.name === 'Prepare Cluster Context');
if (
  !String(prepareClusterContext?.parameters?.jsCode || '').includes(
    'forceReanalysis: runContext.forceReanalysis === true',
  )
) {
  fail('cluster context must preserve the reanalysis boundary');
}
if (!String(prepareUpsert?.parameters?.jsCode || '').includes('comparisonEligible: context.forceReanalysis !== true')) {
  fail('reanalysis must disable non-comparable change metrics');
}
if (!String(prepareClusterUpsert?.parameters?.jsCode || '').includes('comparisonEligible: upsert.comparisonEligible')) {
  fail('cluster upsert must carry the comparison eligibility boundary');
}

const publishInputs = workflow.connections?.['Upsert Clusters to BFF']?.main?.[0] || [];
if (!publishInputs.some((connection) => connection.node === 'Prepare Publish Payload')) {
  fail('publish must run only after cluster validation and persistence');
}

console.log('[workflow-check] OK');
