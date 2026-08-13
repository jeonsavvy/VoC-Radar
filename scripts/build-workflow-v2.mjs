import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER_CATEGORIES,
  CLUSTER_CONTRACT_LIMITS,
  CLUSTER_SEVERITIES,
} from '../contracts/cluster-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(root, 'n8n/workflow.template.json');
const artifactPath = resolve(root, 'n8n/workflow.supabase-only.json');
const codeDirectory = resolve(root, 'n8n/code');

const normalizeNewlines = (source) => source.replace(/\r\n/g, '\n');
const stripOneFinalNewline = (source) => source.endsWith('\n') ? source.slice(0, -1) : source;
const codeData = new Map([
  ['__CLUSTER_CATEGORIES__', JSON.stringify(CLUSTER_CATEGORIES)],
  ['__CLUSTER_SEVERITIES__', JSON.stringify(CLUSTER_SEVERITIES)],
  ['__CLUSTER_CONTRACT_LIMITS__', JSON.stringify(CLUSTER_CONTRACT_LIMITS)],
]);

const templateSource = normalizeNewlines(await readFile(templatePath, 'utf8'));
const workflow = JSON.parse(templateSource);
const referencedSources = new Set();

for (const node of workflow.nodes || []) {
  if (node?.type !== 'n8n-nodes-base.code') continue;
  const reference = node.parameters?.jsCode;
  if (typeof reference !== 'string' || !/^@code\/[a-z0-9-]+\.js$/.test(reference)) {
    throw new Error(`Code node ${node?.name || node?.id || '(unknown)'} must reference @code/<file>.js`);
  }
  if (referencedSources.has(reference)) throw new Error(`duplicate Code-node source reference: ${reference}`);
  referencedSources.add(reference);

  const sourcePath = resolve(codeDirectory, reference.slice('@code/'.length));
  if (!sourcePath.startsWith(`${codeDirectory}${sep}`)) throw new Error(`invalid Code-node source path: ${reference}`);
  let source = stripOneFinalNewline(normalizeNewlines(await readFile(sourcePath, 'utf8')));
  for (const [placeholder, value] of codeData) source = source.replaceAll(placeholder, value);
  if (!source.trim()) throw new Error(`Code-node source is empty: ${reference}`);
  if (/__CLUSTER_[A-Z_]+__/.test(source)) throw new Error(`unresolved cluster contract data: ${reference}`);
  node.parameters.jsCode = source;
}

const generated = `${JSON.stringify(workflow, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const artifact = normalizeNewlines(await readFile(artifactPath, 'utf8'));
  if (generated !== artifact) {
    throw new Error('n8n workflow artifact is stale; run node scripts/build-workflow-v2.mjs');
  }
  console.log(`n8n workflow artifact matches template and ${referencedSources.size} Code-node sources.`);
} else {
  await writeFile(artifactPath, generated);
  console.log(`Generated n8n workflow artifact from template and ${referencedSources.size} Code-node sources.`);
}
