// End-to-end: the real workflow, on a real n8n, against scripted providers.
//
// Needs n8n installed (npm run e2e:install). The test imports a copy of the workflow whose
// HTTP nodes point at tests/mock-providers.mjs, publishes it, starts n8n on a throwaway
// data folder and drives it over HTTP. Nothing touches an existing n8n installation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startMockProviders } from './mock-providers.mjs';

const require = createRequire(import.meta.url);
const N8N_BIN = process.env.N8N_BIN ?? (() => {
  try { return require.resolve('n8n/bin/n8n'); } catch { return null; }
})();

const PORT = 5699;
const ORIGIN = 'https://chat.example.com';
const WORKFLOW_ID = 'llmFailoverE2e01';
const URL_BASE = `http://127.0.0.1:${PORT}`;
const HOSTS = {
  'generativelanguage.googleapis.com': 'gemini',
  'api.groq.com': 'groq',
  'openrouter.ai': 'openrouter',
};

let mock;
let n8n;
let folder;
let log = '';

const env = () => ({
  ...process.env,
  N8N_USER_FOLDER: folder,
  N8N_PORT: String(PORT),
  N8N_LISTEN_ADDRESS: '127.0.0.1',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
  N8N_SECURE_COOKIE: 'false',
  DB_TYPE: 'sqlite',
});

const cli = (...args) => execFileSync(process.execPath, [N8N_BIN, ...args], { env: env(), stdio: 'pipe', encoding: 'utf8' });

async function waitForHealth(ms = 240_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      // The HTTP server answers before the database and the published workflows are ready.
      // A 400 for an empty body means the workflow itself ran its validation.
      const probe = await fetch(`${URL_BASE}/webhook/llm-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (probe.status === 400) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`n8n did not become ready.\n${log.slice(-4000)}`);
}

// n8n writes static data when an execution ends, which is after the webhook has answered.
// A request sent in that gap reads the previous state and then saves over the new one
// (see "Known limitations" in the README). Requests are therefore paced like a person
// typing, not fired like a load test.
const PACE_MS = 750;

async function chat(message, { session = 'e2e-session-01', origin } = {}) {
  const res = await fetch(`${URL_BASE}/webhook/llm-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ session_id: session, message }),
  });
  const result = { status: res.status, headers: res.headers, body: await res.json() };
  await new Promise((r) => setTimeout(r, PACE_MS));
  return result;
}

before(async () => {
  if (!N8N_BIN) return;
  mock = await startMockProviders();
  folder = mkdtempSync(join(tmpdir(), 'n8n-e2e-'));

  // A copy of the workflow that talks to the mock instead of the real APIs.
  const workflow = JSON.parse(readFileSync(new URL('../workflow/llm-failover-router.json', import.meta.url), 'utf8'));
  workflow.id = WORKFLOW_ID;
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const provider = HOSTS[new URL(node.parameters.url).host];
    node.parameters.url = `${mock.url}/${provider}/chat/completions`;
    node.parameters.authentication = 'none';
    delete node.parameters.genericAuthType;
    node.parameters.options.timeout = 3000;
  }
  const file = join(folder, 'workflow.json');
  writeFileSync(file, JSON.stringify(workflow));

  cli('import:workflow', `--input=${file}`);
  cli('publish:workflow', `--id=${WORKFLOW_ID}`);

  n8n = spawn(process.execPath, [N8N_BIN, 'start'], { env: env(), stdio: 'pipe' });
  n8n.stdout.on('data', (d) => { log += d; });
  n8n.stderr.on('data', (d) => { log += d; });
  await waitForHealth();
});

after(async () => {
  if (n8n) {
    const exited = new Promise((r) => n8n.once('exit', r));
    n8n.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  await mock?.close();
  if (folder && existsSync(folder)) rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
});

const skip = N8N_BIN ? false : 'n8n is not installed: run npm run e2e:install';

test('first provider answers and the turn is remembered', { skip }, async () => {
  mock.set({ gemini: { reply: 'first answer' } });
  const first = await chat('Hello', { session: 'e2e-remember-01' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.reply, 'first answer');
  assert.equal(first.body.provider, 'gemini');

  mock.set({ gemini: { reply: 'second answer' } });
  await chat('And then?', { session: 'e2e-remember-01' });
  const sent = mock.calls[0].body.messages.map((m) => `${m.role}:${m.content}`);
  assert.deepEqual(sent.slice(1), ['user:Hello', 'assistant:first answer', 'user:And then?']);
});

// Cooldowns are shared by every execution, so these tests run in order and build on each other.
const minutesFromNow = (iso) => (Date.parse(iso) - Date.now()) / 60e3;

test('a rejected key gets no cooldown, a timeout gets a short one', { skip }, async () => {
  mock.set({ gemini: { status: 401, message: 'Invalid API key' }, groq: { hang: true }, openrouter: { reply: 'from openrouter' } });
  const res = await chat('Hi', { session: 'e2e-rejected-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.provider, 'openrouter');
  assert.deepEqual(mock.calls.map((c) => c.provider), ['gemini', 'groq', 'openrouter']);

  const { cooldowns } = (await chat('/status', { session: 'e2e-rejected-01' })).body;
  assert.equal(cooldowns.gemini, undefined);
  assert.ok(minutesFromNow(cooldowns.groq) > 4 && minutesFromNow(cooldowns.groq) <= 5, JSON.stringify(cooldowns));
});

test('a quota error fails over with the full conversation and rests the provider for 30 minutes', { skip }, async () => {
  mock.set({ gemini: { status: 429 }, openrouter: { reply: 'from openrouter' } });
  const res = await chat('Hi', { session: 'e2e-failover-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.provider, 'openrouter');
  // Groq is still resting from the previous test, so it is skipped rather than called.
  assert.deepEqual(mock.calls.map((c) => c.provider), ['gemini', 'openrouter']);
  assert.deepEqual(mock.calls[1].body.messages, mock.calls[0].body.messages);

  // The cooldown is written to static data and survives into the next execution.
  mock.set({ gemini: { reply: 'should not be called' }, openrouter: { reply: 'again' } });
  await chat('Again', { session: 'e2e-failover-01' });
  assert.deepEqual(mock.calls.map((c) => c.provider), ['openrouter']);

  const { cooldowns } = (await chat('/status', { session: 'e2e-failover-01' })).body;
  assert.ok(minutesFromNow(cooldowns.gemini) > 29 && minutesFromNow(cooldowns.gemini) <= 30, JSON.stringify(cooldowns));
});

test('when the last provider fails too, the caller gets a 503', { skip }, async () => {
  mock.set({ openrouter: { empty: true } });
  const res = await chat('Hi', { session: 'e2e-cascade-01' });
  assert.equal(res.status, 503);
  assert.deepEqual(res.body.error.last_failure, { provider: 'openrouter', reason: 'bad_response' });
});

test('a request is refused before any provider is called', { skip }, async () => {
  mock.set({});
  assert.equal((await chat('Hi', { session: 'short' })).status, 400);
  assert.equal((await chat('x'.repeat(4001))).status, 413);
  const foreign = await chat('Hi', { origin: 'https://elsewhere.example' });
  assert.equal(foreign.status, 403);
  assert.equal(mock.calls.length, 0);
});

test('CORS headers come from the Webhook node', { skip }, async () => {
  const preflight = await fetch(`${URL_BASE}/webhook/llm-chat`, {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  const res = await chat('/status', { origin: ORIGIN });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});
