import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentLoop } from '../src/agent/agentLoop.js';

/** Stands in for the backend: /api/agent/context, and /api/agent/turn answering with reply(n) for the n-th model call. */
async function withBackend(reply, fn) {
  const originalFetch = globalThis.fetch;
  let turns = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/agent/context')) return Response.json({ context_tokens: 128000, reply_tokens: 8192, system_prompt_tokens: 2000 });
    turns += 1;
    const { toolCalls = [], finishReason = 'tool_calls' } = reply(turns);
    const events = [
      ...(toolCalls.length ? [{ type: 'tool_calls', tool_calls: toolCalls }] : []),
      { type: 'done', finish_reason: finishReason },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    return await fn(() => turns);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const invalidProposal = (n) => ({ toolCalls: [{ id: `c${n}`, name: 'propose_changes', arguments: '{"summary":"x","operations":[]}' }] });

test('proposals sent back for a fix count toward the tool budget, so the loop ends', async () => {
  const messages = [{ role: 'user', content: 'Build it' }];
  const runtime = { previewProposal: async () => ({ ok: false, error: 'Unknown column.' }) };
  await withBackend(invalidProposal, async (turns) => {
    const outcome = await runAgentLoop({ messages, credentialId: 'c', runtime, workspaceSummary: '' });
    assert.equal(outcome, 'answered');
    // 30 rejected proposals, one told the budget is used up, then the model's next call closes the turn.
    assert.equal(turns(), 32);
  });
  const results = messages.filter((m) => m.role === 'tool');
  assert.equal(results.filter((m) => JSON.parse(m.content).status === 'invalid').length, 30);
  assert.match(messages.at(-1).content, /stopped here/);
});

test('arguments cut off by the output token limit are reported as such', async () => {
  const messages = [{ role: 'user', content: 'Write the Process' }];
  const runtime = { previewProposal: async () => { throw new Error('not reached'); } };
  const reply = (n) => (n === 1
    ? { toolCalls: [{ id: 'c1', name: 'propose_changes', arguments: '{"summary":"Add","operations":[{"op":"add_process","code":"def pro' }], finishReason: 'length' }
    : { toolCalls: [{ id: 'q', name: 'ask_user', arguments: '{"question":"Split it?","options":["Yes","No"]}' }] });
  await withBackend(reply, async () => {
    assert.equal(await runAgentLoop({ messages, credentialId: 'c', runtime, workspaceSummary: '' }), 'waiting');
  });
  const result = JSON.parse(messages.find((m) => m.role === 'tool').content);
  assert.equal(result.status, 'invalid');
  assert.match(result.error, /output token limit/);
});

test('arguments that are merely malformed keep the plain JSON error', async () => {
  const messages = [{ role: 'user', content: 'Look' }];
  const reply = (n) => (n === 1
    ? { toolCalls: [{ id: 'c1', name: 'inspect_node', arguments: '{not json' }] }
    : { finishReason: 'stop', toolCalls: [{ id: 'q', name: 'ask_user', arguments: '{"question":"Which?","options":["A","B"]}' }] });
  await withBackend(reply, async () => {
    await runAgentLoop({ messages, credentialId: 'c', runtime: {}, workspaceSummary: '' });
  });
  const result = JSON.parse(messages.find((m) => m.role === 'tool').content);
  assert.equal(result.error, 'The arguments were not valid JSON.');
});
