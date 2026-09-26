// Extracts the reply from an OpenAI-compatible response.
// An empty or malformed answer is thrown on purpose: the node's error output
// sends it to the failure handler, and the next provider gets a chance.

const PROVIDER = '__PROVIDER__';

const response = $input.first().json;
const reply = response.choices?.[0]?.message?.content;
if (typeof reply !== 'string' || !reply.trim()) {
  throw new Error(`${PROVIDER} returned an empty or malformed response`);
}

return [{
  json: {
    ...$('Validate request').first().json,
    provider: PROVIDER,
    model: response.model ?? null,
    reply,
    usage: response.usage ?? null,
  },
}];
