// Runs the exported workflow without n8n, following its real connections.
//
// Code nodes execute their actual source; IF and Respond nodes evaluate their actual
// expressions; HTTP Request nodes return scripted results. Error items reproduce the
// shapes n8n 2.40 produces (captured with tests/e2e.test.mjs), so the failure handlers
// are tested against what they will really receive.
//
// It is a model of n8n, not n8n: tests/e2e.test.mjs runs the same workflow on the real thing.

import assert from 'node:assert/strict';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const PROVIDER_BY_HOST = {
  'generativelanguage.googleapis.com': 'gemini',
  'api.groq.com': 'groq',
  'openrouter.ai': 'openrouter',
};

// A stack like n8n's, including line numbers that look like 5xx status codes.
const STACK = 'AxiosError: Request failed\n    at RedirectableRequest.emit (node:events:521:24)\n    at ClientRequest.emit (node:events:509:28)';

export const outcome = {
  reply: (text) => ({ body: { model: 'mock-model', choices: [{ message: { role: 'assistant', content: text } }], usage: { total_tokens: 15 } } }),
  empty: () => ({ body: { choices: [{ message: { role: 'assistant', content: '' } }] } }),
  status: (status, message = `${status} - "{\\"error\\":{}}"`) => ({
    error: { message, name: 'AxiosError', stack: STACK, code: status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', status },
  }),
  // What n8n reports for a 429: its own hint as the message, the status in its own field.
  quota: () => outcome.status(429, "Try spacing your requests out using the batching settings under 'Options'"),
  timeout: () => ({ error: { message: 'timeout of 45000ms exceeded', name: 'AxiosError', stack: STACK, code: 'ECONNABORTED' } }),
  refused: () => ({ error: { message: 'connect ECONNREFUSED', name: 'Error', stack: STACK, code: 'ECONNREFUSED' } }),
};

function evaluate(value, $json, $) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const inner = value.slice(1).match(/^\{\{([\s\S]*)\}\}$/);
  assert.ok(inner, `unsupported expression: ${value}`);
  return new Function('$json', '$', `return (${inner[1]});`)($json, $);
}

export function createSimulator(workflow) {
  const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
  const trigger = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.webhook');

  // One call = one execution. `store` is the workflow's static data and outlives executions.
  return async function execute(store, { body, headers = {} }, providers = {}) {
    const outputs = {};
    const calls = [];
    const $ = (name) => {
      assert.ok(name in nodes, `unknown node: ${name}`);
      return {
        params: nodes[name].parameters,
        get isExecuted() { return name in outputs; },
        first: () => {
          assert.ok(name in outputs, `node has not run yet: ${name}`);
          return { json: outputs[name] };
        },
      };
    };

    let name = trigger.name;
    let json = { headers, params: {}, query: {}, body };
    for (let step = 0; step < 100; step++) {
      const node = nodes[name];
      let output = 0;

      switch (node.type) {
        case 'n8n-nodes-base.webhook':
          break;
        case 'n8n-nodes-base.code': {
          const run = new AsyncFunction('$input', '$', '$getWorkflowStaticData', node.parameters.jsCode);
          try {
            [{ json }] = await run({ first: () => ({ json }) }, $, () => store);
          } catch (error) {
            assert.equal(node.onError, 'continueErrorOutput', `${name} threw with no error output: ${error.stack}`);
            json = { error: `${error.message} [line 10]` };
            output = 1;
          }
          break;
        }
        case 'n8n-nodes-base.if': {
          const condition = node.parameters.conditions.conditions[0];
          const value = evaluate(condition.leftValue, json, $);
          // Strict type validation: anything but a boolean stops the execution in n8n.
          assert.equal(typeof value, 'boolean', `${name}: strict validation rejects ${JSON.stringify(value)}`);
          output = value === (condition.operator.operation === 'true') ? 0 : 1;
          break;
        }
        case 'n8n-nodes-base.httpRequest': {
          const provider = PROVIDER_BY_HOST[new URL(node.parameters.url).host];
          const request = evaluate(node.parameters.jsonBody, json, $);
          calls.push({ provider, request });
          const result = (providers[provider] ?? outcome.refused)();
          if (result.error) {
            json = { error: result.error };
            output = 1;
          } else {
            json = result.body;
          }
          break;
        }
        case 'n8n-nodes-base.respondToWebhook':
          return {
            node: name,
            status: Number(evaluate(node.parameters.options.responseCode, json, $)),
            body: JSON.parse(evaluate(node.parameters.responseBody, json, $)),
            calls,
          };
        default:
          throw new Error(`node type not modelled: ${node.type}`);
      }

      outputs[name] = json;
      const next = workflow.connections[name]?.main?.[output]?.[0]?.node;
      assert.ok(next, `${name}: output ${output} leads nowhere`);
      name = next;
    }
    throw new Error('execution did not reach a Respond node');
  };
}
