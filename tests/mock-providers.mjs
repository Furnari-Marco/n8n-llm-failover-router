// A stand-in for the three LLM APIs, used by the end-to-end test.
// Each provider answers POST /<provider>/chat/completions according to a scripted behaviour,
// and every call is recorded so the test can check who was asked, in which order, with what.

import { createServer } from 'node:http';

export async function startMockProviders() {
  const behaviour = {};
  const calls = [];

  const server = createServer(async (req, res) => {
    const provider = req.url.split('/')[1];
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ provider, body });

    const plan = behaviour[provider] ?? { reply: `hello from ${provider}` };
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (plan.status) return send(plan.status, { error: { message: plan.message ?? `HTTP ${plan.status}` } });
    if (plan.empty) return send(200, { choices: [{ message: { role: 'assistant', content: '' } }] });
    if (plan.hang) return; // never answers: exercises the node timeout
    return send(200, {
      model: `${provider}-model`,
      choices: [{ message: { role: 'assistant', content: plan.reply } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    set(plans) {
      for (const key of Object.keys(behaviour)) delete behaviour[key];
      Object.assign(behaviour, plans);
      calls.length = 0;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
