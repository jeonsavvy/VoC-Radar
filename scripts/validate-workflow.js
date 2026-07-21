#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.resolve(__dirname, '../n8n/workflow.supabase-only.json');

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
