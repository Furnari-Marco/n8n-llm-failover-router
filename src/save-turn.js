// A provider has answered: only now is the turn written to the session.

const turn = $input.first().json;
const store = $getWorkflowStaticData('global');
store.sessions ??= {};
store.cooldowns ??= {};

const messages = [...turn.history, { role: 'assistant', content: turn.reply }].slice(-turn.historyLimit);
store.sessions[turn.sessionId] = { messages, updatedAt: new Date().toISOString() };

// A provider that answers is healthy again, whatever its cooldown said.
delete store.cooldowns[turn.provider];

return [{
  json: {
    session_id: turn.sessionId,
    reply: turn.reply,
    provider: turn.provider,
    model: turn.model,
    usage: turn.usage,
  },
}];
