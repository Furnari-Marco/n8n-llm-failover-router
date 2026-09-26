// Copies the Code node sources in src/ into the workflow export.
//
// The JavaScript lives in src/ so it can be read, diffed and reviewed as code.
// The workflow JSON is what gets imported into n8n. This script keeps the two identical:
//   node scripts/sync-code.mjs          rewrite the workflow
//   node scripts/sync-code.mjs --check  fail if the workflow is out of date (used in CI)

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const WORKFLOW = new URL('workflow/llm-failover-router.json', root);
const PROVIDERS = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };

const source = (file, provider) => {
  const code = readFileSync(new URL(`src/${file}`, root), 'utf8').replace(/\r\n/g, '\n');
  return provider ? code.replaceAll('__PROVIDER__', provider) : code;
};

// Node name -> code it must contain.
const expected = {
  'Validate request': source('validate-request.js'),
  'Save turn': source('save-turn.js'),
};
for (const [key, label] of Object.entries(PROVIDERS)) {
  expected[`${label}: parse reply`] = source('parse-reply.js', key);
  expected[`${label}: record failure`] = source('record-failure.js', key);
}

const current = readFileSync(WORKFLOW, 'utf8');
const workflow = JSON.parse(current);
const codeNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.code');

const unknown = codeNodes.map((node) => node.name).filter((name) => !(name in expected));
const missing = Object.keys(expected).filter((name) => !codeNodes.some((node) => node.name === name));
if (unknown.length || missing.length) {
  console.error(`Code nodes out of step with src/. Unknown: ${unknown.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`);
  process.exit(1);
}

for (const node of codeNodes) node.parameters.jsCode = expected[node.name];
const next = `${JSON.stringify(workflow, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('workflow/llm-failover-router.json is out of date. Run: npm run sync');
    process.exit(1);
  }
  console.log('Workflow is in sync with src/.');
} else {
  writeFileSync(WORKFLOW, next);
  console.log(next === current ? 'Already in sync.' : 'Workflow updated from src/.');
}
