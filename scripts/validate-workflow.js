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

const llmNode = nodes.find((node) => node.name === 'Basic LLM Chain');
if (!llmNode) {
  fail('required node not found: Basic LLM Chain');
}

if (llmNode.executeOnce !== false) {
  fail('Basic LLM Chain.executeOnce must be false to process all review batches');
}

console.log('[workflow-check] OK');
