import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentLoop, toApiMessages } from '../src/agent/agentLoop.js';
import { fitHistory } from '../src/agent/historyBudget.js';

test('reasoning context counts toward the history budget and is removed only with its whole earlier turn', () => {
  const messages = [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Short answer', reasoningContent: 'r'.repeat(20000) },
    { role: 'user', content: 'Current question' },
  ];
  assert.deepEqual(fitHistory(messages, 4000), [messages[2]]);
  assert.equal(messages[1].reasoningContent.length, 20000);
  assert.equal(fitHistory(messages, 10000), messages);
});

test('reasoner tool context survives a confirmation and is never merged into visible answer text', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/api/agent/context')) return Response.json({context_tokens:128000,reply_tokens:8192,system_prompt_tokens:2000});
    const body = JSON.parse(options.body);
    requests.push(body);
    const events = requests.length === 1
      ? [{type:'reasoning',delta:'Private reasoning context'}, {type:'text',delta:'Please confirm.'},
         {type:'tool_calls',tool_calls:[{id:'proposal-1',name:'propose_changes',arguments:'{"summary":"Create a table","operations":[]}'}]},
         {type:'done',finish_reason:'tool_calls'}]
      : [{type:'text',delta:'Confirmed.'},{type:'done',finish_reason:'stop'}];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers:{'Content-Type':'text/event-stream'}});
  };
  try {
    const messages = [{role:'user',content:'Create a table'}];
    const runtime = { previewProposal: async () => ({ok:true,items:[]}) };
    assert.equal(await runAgentLoop({messages,credentialId:'annobio-free',runtime,workspaceSummary:''}), 'waiting');
    const assistant = messages.find(message => message.role === 'assistant');
    assert.equal(assistant.content, 'Please confirm.');
    assert.equal(assistant.reasoningContent, 'Private reasoning context');
    assert.equal(toApiMessages(messages).find(message => message.role === 'assistant').reasoning_content, 'Private reasoning context');
    messages.push({role:'tool',toolCallId:'proposal-1',name:'propose_changes',content:'{"status":"applied"}',ok:true});
    assert.equal(await runAgentLoop({messages,credentialId:'annobio-free',runtime,workspaceSummary:''}), 'answered');
    assert.equal(requests[1].messages.find(message => message.role === 'assistant').reasoning_content, 'Private reasoning context');
    assert.equal(messages.at(-1).content, 'Confirmed.');
  } finally { globalThis.fetch = previousFetch; }
});
