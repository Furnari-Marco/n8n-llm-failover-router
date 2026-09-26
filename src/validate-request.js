// Validates the request, applies rate limits and loads the conversation.
// Everything that can turn a request away happens here, before any provider is called.

const SYSTEM_PROMPT = 'You are a helpful assistant. Answer clearly and concisely, and say so when you do not know something.';
const PROVIDERS = ['gemini', 'groq', 'openrouter']; // same order as the branches in the workflow
const MAX_MESSAGE_CHARS = 4000;
const HISTORY_MESSAGES = 24;   // messages kept per session, and sent to the model
const SESSION_TTL_HOURS = 24;
const MAX_SESSIONS = 100;      // static data is meant to stay small
const RATE_WINDOW_MINUTES = 10;
const RATE_PER_SESSION = 20;
const RATE_GLOBAL = 120;       // caps spend even when a caller rotates session ids

const request = $input.first().json;
const body = request.body ?? {};
const headers = request.headers ?? {};

const respondNow = (status, payload) => [{ json: { respondNow: true, status, payload } }];
const reject = (status, code, message) => respondNow(status, { error: { code, message } });

// CORS only stops a browser from reading the response: the request itself still runs and
// still spends quota. A browser on a site that is not allowed is therefore refused here.
// The allowed list is read from the Webhook node, so it is configured in one place.
const allowedOrigins = String($('Webhook').params.options?.allowedOrigins ?? '*')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
if (headers.origin && !allowedOrigins.includes('*') && !allowedOrigins.includes(headers.origin)) {
  return reject(403, 'origin_not_allowed', 'This origin is not allowed to call the endpoint.');
}

// There is no shared fallback session: a missing id must never merge two users' conversations.
const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
  return reject(400, 'invalid_session_id', 'session_id is required: 8 to 64 letters, digits, "-" or "_".');
}
const message = typeof body.message === 'string' ? body.message.trim() : '';
if (!message) {
  return reject(400, 'empty_message', 'message is required.');
}
if (message.length > MAX_MESSAGE_CHARS) {
  return reject(413, 'message_too_long', `message is limited to ${MAX_MESSAGE_CHARS} characters.`);
}

const store = $getWorkflowStaticData('global');
store.sessions ??= {};
store.cooldowns ??= {};
store.hits ??= {};
const now = Date.now();

// Housekeeping runs on every request, so the store is bounded without a scheduled job.
for (const [id, session] of Object.entries(store.sessions)) {
  if (!(now - Date.parse(session.updatedAt) <= SESSION_TTL_HOURS * 3600e3)) delete store.sessions[id];
}
const oldestFirst = Object.keys(store.sessions)
  .sort((a, b) => Date.parse(store.sessions[a].updatedAt) - Date.parse(store.sessions[b].updatedAt));
for (const id of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_SESSIONS))) delete store.sessions[id];

// Sliding-window rate limits, per session and in total.
const windowStart = now - RATE_WINDOW_MINUTES * 60e3;
for (const [key, times] of Object.entries(store.hits)) {
  const recent = times.filter((t) => t > windowStart);
  if (recent.length) store.hits[key] = recent;
  else delete store.hits[key];
}
const sessionKey = `session:${sessionId}`;
if ((store.hits.global?.length ?? 0) >= RATE_GLOBAL || (store.hits[sessionKey]?.length ?? 0) >= RATE_PER_SESSION) {
  return reject(429, 'rate_limited', 'Too many requests. Try again in a few minutes.');
}
store.hits.global = [...(store.hits.global ?? []), now];
store.hits[sessionKey] = [...(store.hits[sessionKey] ?? []), now];

const stored = store.sessions[sessionId]?.messages ?? [];

if (message === '/reset') {
  delete store.sessions[sessionId];
  return respondNow(200, { session_id: sessionId, reset: true });
}
if (message === '/status') {
  const cooldowns = Object.fromEntries(Object.entries(store.cooldowns)
    .filter(([, until]) => until > now)
    .map(([provider, until]) => [provider, new Date(until).toISOString()]));
  return respondNow(200, { session_id: sessionId, messages: stored.length, cooldowns });
}

// A copy, not a reference: the stored session changes only once a provider has answered.
const history = [...stored, { role: 'user', content: message }].slice(-HISTORY_MESSAGES);

return [{
  json: {
    respondNow: false,
    sessionId,
    history,
    historyLimit: HISTORY_MESSAGES,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    available: Object.fromEntries(PROVIDERS.map((p) => [p, !(store.cooldowns[p] > now)])),
  },
}];
