#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW_PATH = path.resolve(__dirname, '../n8n/workflow.supabase-only.json');
const COMPOSE_PATH = path.resolve(__dirname, '../n8n/compose.yaml');
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../n8n/.env.example');
const BUILDER_PATH = path.resolve(__dirname, './build-workflow-v2.mjs');

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

const builderCheck = spawnSync(process.execPath, [BUILDER_PATH, '--check'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
});
if (builderCheck.status !== 0) {
  fail((builderCheck.stderr || builderCheck.stdout || 'workflow builder check failed').trim());
}

for (const requiredComposeLine of [
  'N8N_PIPELINE_TRIGGER_SECRET: ${N8N_PIPELINE_TRIGGER_SECRET:?N8N_PIPELINE_TRIGGER_SECRET is required}',
  'N8N_RUNNERS_MODE: external',
  'N8N_RUNNERS_AUTH_TOKEN: ${N8N_RUNNERS_AUTH_TOKEN:?N8N_RUNNERS_AUTH_TOKEN is required}',
  'N8N_RUNNERS_BROKER_LISTEN_ADDRESS: 0.0.0.0',
  'image: n8nio/runners:2.30.8',
  'N8N_RUNNERS_TASK_BROKER_URI: http://n8n:5679',
  'N8N_RUNNERS_LAUNCHER_HEALTH_CHECK_PORT: "5680"',
  'wget -q -O - http://127.0.0.1:5680/healthz >/dev/null 2>&1',
  'EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none"',
  'EXECUTIONS_DATA_SAVE_ON_ERROR: "none"',
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

if (compose.includes('N8N_RUNNERS_MODE: internal')) {
  fail('production n8n must isolate Code nodes in the external task-runner service');
}

if (!/^N8N_PIPELINE_TRIGGER_SECRET=<[^>]+>$/m.test(envExample)) {
  fail('.env.example must declare N8N_PIPELINE_TRIGGER_SECRET');
}
if (!/^N8N_RUNNERS_AUTH_TOKEN=<[^>]+>$/m.test(envExample)) {
  fail('.env.example must declare the external task-runner shared secret');
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
  workflow.settings?.saveDataErrorExecution !== 'none' ||
  workflow.settings?.saveExecutionProgress !== false ||
  workflow.settings?.saveManualExecutions !== false
) {
  fail('workflow execution settings must not retain production execution payloads');
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

  const renew = nodes.find((node) => node.name === contract.renew);
  if (
    !String(renew?.parameters?.url || '').includes('/api/internal/pipeline/heartbeat') ||
    renew?.parameters?.jsonBody !== '={{ $json.heartbeatPayload }}'
  ) {
    fail(`${contract.renew} must renew the captured claim through the heartbeat endpoint`);
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

if (!String(nodes.find((node) => node.name === 'Prepare Cluster Input')?.notes || '').includes(
  '최대 160개, 49152 UTF-8 bytes',
)) {
  fail('cluster batches must contain only bounded selected existing-cluster context');
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
const workerTimeoutSource = fs.readFileSync(
  path.resolve(__dirname, '../apps/worker/src/internal.ts'),
  'utf8',
);
for (const fragment of [
  'const FETCH_REVIEWS_DEADLINE_MS = 270_000',
  'const APPLE_REVIEW_PAGE_TIMEOUT_MS = 5_000',
]) {
  if (!workerTimeoutSource.includes(fragment)) {
    fail(`Worker review/timeout contract is missing: ${fragment}`);
  }
}

const consolidateCandidates = nodes.find((node) => node.name === 'Consolidate Cluster Candidates');
if (
  consolidateCandidates?.parameters?.text !== '={{ $json.prompt }}' ||
  !String(consolidateCandidates?.notes || '').includes('후보 최대 48개') ||
  !String(consolidateCandidates?.notes || '').includes('65536 UTF-8 bytes')
) {
  fail('candidate consolidation must consume only the pre-measured bounded prompt');
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
if (
  consolidationLoop?.type !== 'n8n-nodes-base.splitInBatches' ||
  consolidationLoop?.typeVersion !== 3 ||
  consolidationLoop?.parameters?.batchSize !== 1
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
if (
  extractionGate?.type !== 'n8n-nodes-base.code' ||
  extractionGate?.parameters?.mode !== 'runOnceForAllItems'
) {
  fail('Gate Extraction Batches must evaluate the extraction result as one global barrier');
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

if (nodes.some((node) => ['Check Critical Priority', 'Has Critical Alerts?'].includes(node.name))) {
  fail('n8n must not own or branch on the Worker-owned priority rule');
}
const prepareAlerts = nodes.find((node) => node.name === 'Prepare Alert Events Payload');
if (prepareAlerts?.parameters?.mode !== 'runOnceForAllItems') {
  fail('Prepare Alert Events Payload must serialize raw facts through one Worker request');
}
if (nodes.some((node) => node.name === 'Restore Reviews After Alerts')) {
  fail('the alert barrier must reuse the existing review set without a restore workaround');
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
  ['Send Alert Events to BFF'],
  'raw alert facts must be sent to the Worker before analysis continues',
);
requireOnlyMainTargets(
  'Send Alert Events to BFF',
  0,
  ['Prepare Cluster Context'],
  'Worker-owned alert filtering and persistence must complete before clustering',
);
requireOnlyMainSources(
  'Prepare Cluster Context',
  ['Send Alert Events to BFF'],
  'clustering must accept only the serialized Worker alert result',
);
requireOnlyMainSources(
  'Send Alert Events to BFF',
  ['Prepare Alert Events Payload'],
  'alert persistence must be reachable only from the raw-fact payload',
);
if (!hasMainPath('Send Alert Events to BFF', 'Notify Publish to BFF')) {
  fail('the alert path must reach publish only after Worker persistence');
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
