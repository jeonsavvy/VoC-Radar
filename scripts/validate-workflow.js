#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

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

const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');
const envExample = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
const builderSource = fs.readFileSync(BUILDER_PATH, 'utf8');

for (const requiredComposeLine of [
  'N8N_PIPELINE_TRIGGER_SECRET: ${N8N_PIPELINE_TRIGGER_SECRET:?N8N_PIPELINE_TRIGGER_SECRET is required}',
  'EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none"',
  'EXECUTIONS_DATA_SAVE_ON_ERROR: "all"',
  'EXECUTIONS_DATA_SAVE_ON_PROGRESS: "false"',
  'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "false"',
  'EXECUTIONS_DATA_PRUNE: "true"',
  'EXECUTIONS_DATA_MAX_AGE: "168"',
]) {
  if (!compose.includes(requiredComposeLine)) {
    fail(`compose is missing required execution/security setting: ${requiredComposeLine.split(':')[0]}`);
  }
}

if (!/^N8N_PIPELINE_TRIGGER_SECRET=<[^>]+>$/m.test(envExample)) {
  fail('.env.example must declare N8N_PIPELINE_TRIGGER_SECRET');
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
  !/if\s*\(!jobId\s*\|\|\s*status\s*!==\s*'running'\)\s*{[\s\S]*?return\s*\[\];[\s\S]*?}/.test(
    runContextCode,
  )
) {
  fail('Prepare Run Context must stop on empty or terminal idempotent claim responses');
}
const fetchPayloadBlock = runContextCode.match(/const\s+fetchPayload\s*=\s*{([\s\S]*?)};/)?.[1] || '';
for (const field of ['jobId', 'claimToken', 'runId']) {
  if (!new RegExp(`\\b${field}\\b`).test(fetchPayloadBlock)) {
    fail(`fetch payload must carry ${field}`);
  }
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

const llmNode = nodes.find((node) => node.name === 'Basic LLM Chain');
if (!llmNode) {
  fail('required node not found: Basic LLM Chain');
}

if (llmNode.executeOnce !== false) {
  fail('Basic LLM Chain.executeOnce must be false to process all review batches');
}

for (const requiredName of [
  'Cluster Review Issues',
  'Validate Cluster Output',
  'Merge Cluster Batches',
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
  ['Validate Cluster Output', '../n8n/code/validate-cluster-output.js'],
  ['Merge Cluster Batches', '../n8n/code/merge-cluster-batches.js'],
  ['Validate Consolidated Clusters', '../n8n/code/validate-consolidated-clusters.js'],
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
if (!mergeOutputs.some((connection) => connection.node === 'Consolidate Cluster Candidates')) {
  fail('merged cluster output must pass through candidate consolidation');
}

const consolidationOutputs = workflow.connections?.['Consolidate Cluster Candidates']?.main?.[0] || [];
if (!consolidationOutputs.some((connection) => connection.node === 'Validate Consolidated Clusters')) {
  fail('candidate consolidation output must be validated');
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
