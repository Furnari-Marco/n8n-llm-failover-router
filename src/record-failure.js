// __PROVIDER__ has failed: record a cooldown when waiting is likely to help,
// then hand the untouched conversation to the next provider.
//
// An error output carries only { error }, not the item that went in. The context is
// therefore re-read from 'Validate request'; without this step the next provider
// would be called with an empty request.

const PROVIDER = '__PROVIDER__';
const QUOTA_COOLDOWN_MINUTES = 30;  // a 429 can be a per-minute or a per-day limit: 30 minutes covers most of both
const OUTAGE_COOLDOWN_MINUTES = 5;
const NETWORK_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// From the HTTP Request node: { message, code, status, stack }. From the parse node: a string.
// Only the structured fields are read. The stack is never searched: its line numbers
// (events:521:24) look exactly like HTTP status codes.
const error = $input.first().json.error;
const message = String(typeof error === 'string' ? error : error?.message ?? 'unknown error');
const status = Number(error?.status ?? error?.httpCode) || null;
const code = String(error?.code ?? '');

function classify() {
  if (status === 429) return 'quota';
  if (status >= 500) return 'outage';
  // Some APIs report an exhausted quota as a 400 or a 403.
  if (status >= 400) return /quota|rate.?limit|resource.?exhausted/i.test(message) ? 'quota' : 'rejected';
  if (NETWORK_CODES.has(code)) return 'outage';
  return 'bad_response';
}
const reason = classify();

// 'rejected' (bad key, unknown model) and 'bad_response' get no cooldown:
// the first needs a configuration fix that waiting will not bring, the second is often a one-off.
const minutes = { quota: QUOTA_COOLDOWN_MINUTES, outage: OUTAGE_COOLDOWN_MINUTES }[reason] ?? 0;
if (minutes) {
  const store = $getWorkflowStaticData('global');
  store.cooldowns ??= {};
  store.cooldowns[PROVIDER] = Date.now() + minutes * 60e3;
}

return [{
  json: {
    ...$('Validate request').first().json,
    lastFailure: { provider: PROVIDER, reason, status, message: message.slice(0, 300) },
  },
}];
