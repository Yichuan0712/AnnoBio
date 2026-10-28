import assert from 'node:assert/strict';
import test from 'node:test';
import { findPendingInteraction, resolveCreateProject, runAgentLoop } from '../src/agent/agentLoop.js';
import { executeCreateProject, previewCreateProject } from '../src/agent/project/createProject.js';
import { AGENT_TOOL_DEFINITIONS } from '../src/agent/tools/agentTools.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';

/** Stands in for the backend and records each /api/agent/turn request body; reply(n) answers the n-th. */
async function withBackend(reply, fn) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/agent/context')) return Response.json({ context_tokens: 128000, reply_tokens: 8192, system_prompt_tokens: 2000 });
    requests.push(JSON.parse(init.body));
    const { toolCalls = [], text = '' } = reply(requests.length);
    const events = [
      ...(text ? [{ type: 'text', delta: text }] : []),
      ...(toolCalls.length ? [{ type: 'tool_calls', tool_calls: toolCalls }] : []),
      { type: 'done', finish_reason: toolCalls.length ? 'tool_calls' : 'stop' },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const toolNames = (request) => request.tools.map((definition) => definition.function.name).sort();

test('with no project open only the tools that need no canvas, and create_project, are offered', async () => {
  await withBackend(() => ({ text: 'Tell me about your data.' }), async (requests) => {
    await runAgentLoop({ messages: [{ role: 'user', content: 'Hi' }], credentialId: 'c', runtime: { projectOpen: false }, workspaceSummary: 'No project is open.' });
    assert.deepEqual(toolNames(requests[0]), ['ask_user', 'create_project', 'inspect_source', 'list_models', 'read_guide', 'search_source']);
    assert.equal(requests[0].project_open, false);
  });
});

test('with a project open every tool is offered, as before', async () => {
  await withBackend(() => ({ text: 'Done.' }), async (requests) => {
    await runAgentLoop({ messages: [{ role: 'user', content: 'Hi' }], credentialId: 'c', runtime: {}, workspaceSummary: '' });
    assert.deepEqual(requests[0].tools, AGENT_TOOL_DEFINITIONS);
    assert.equal(requests[0].project_open, true);
  });
});

test('a canvas tool called anyway with no project open goes back as unavailable', async () => {
  const messages = [{ role: 'user', content: 'Show the rows' }];
  const reply = (n) => (n === 1
    ? { toolCalls: [{ id: 'c1', name: 'read_rows', arguments: '{"node_id":"n1"}' }, { id: 'c2', name: 'propose_changes', arguments: '{"summary":"x","operations":[]}' }] }
    : { text: 'Open a project first.' });
  const runtime = { projectOpen: false, previewProposal: async () => { throw new Error('not reached'); } };
  await withBackend(reply, async () => {
    assert.equal(await runAgentLoop({ messages, credentialId: 'c', runtime, workspaceSummary: '' }), 'answered');
  });
  const results = messages.filter((m) => m.role === 'tool');
  assert.deepEqual(results.map((m) => JSON.parse(m.content).error), [
    'read_rows is not available: no project is open.',
    'propose_changes is not available: no project is open.',
  ]);
});

test('the workspace summary says no project is open and still lists the models', async () => {
  const credentialsById = new Map([['k', { id: 'k', model: 'openai/gpt-4o-mini', last_check_ok: true }]]);
  const summary = await buildWorkspaceSummary({ nodes: [], connections: [] }, { projectOpen: false, credentialsById, defaultRunCredential: null });
  assert.match(summary, /^No project is open\./);
  assert.doesNotMatch(summary, /canvas is empty/);
  assert.match(summary, /openai\/gpt-4o-mini/);
  const withProject = await buildWorkspaceSummary({ nodes: [], connections: [] }, { credentialsById, defaultRunCredential: null });
  assert.match(withProject, /^The canvas is empty\./);
});

test('create_project with a project open goes back as unavailable', async () => {
  const messages = [{ role: 'user', content: 'Start over' }];
  const reply = (n) => (n === 1
    ? { toolCalls: [{ id: 'c1', name: 'create_project', arguments: '{"name":"New","summary":"x"}' }] }
    : { text: 'Use File → New.' });
  await withBackend(reply, async () => {
    await runAgentLoop({ messages, credentialId: 'c', runtime: {}, workspaceSummary: '' });
  });
  assert.equal(JSON.parse(messages.find((m) => m.role === 'tool').content).error, 'create_project is not available: a project is already open.');
});

test('a create_project call waits on a card, and its outcome is recorded', async () => {
  const messages = [{ role: 'user', content: 'Build a phosphosite extractor' }];
  const runtime = { projectOpen: false, previewCreateProject: (args) => previewCreateProject(args, { hasProject: () => false }) };
  const reply = () => ({ toolCalls: [{ id: 'p1', name: 'create_project', arguments: '{"name":"  Phosphosite   extraction ","summary":"A project for the extractor."}' }] });
  await withBackend(reply, async () => {
    assert.equal(await runAgentLoop({ messages, credentialId: 'c', runtime, workspaceSummary: '' }), 'waiting');
  });
  const pending = findPendingInteraction(messages);
  assert.equal(pending.kind, 'project');
  assert.equal(pending.preview.name, 'Phosphosite extraction');
  assert.equal(pending.preview.items[0].title, 'Create project "Phosphosite extraction"');
  resolveCreateProject(messages, pending, { status: 'created', name: 'Phosphosite extraction', path: 'C:/p.yc' });
  assert.equal(messages.at(-1).outcome, 'Created: Phosphosite extraction');
  assert.equal(findPendingInteraction(messages), null);
});

test('create_project is checked before its card and passes the conversation to the creator', async () => {
  assert.match(previewCreateProject({ name: '  ' }, {}).error, /name/);
  assert.match(previewCreateProject({ name: 'x'.repeat(81) }, {}).error, /80 characters/);
  assert.match(previewCreateProject({ name: 'Sites' }, { hasProject: () => true }).error, /already open/);

  const calls = [];
  const workspace = { hasProject: () => false, createProject: async (request) => { calls.push(request); return { status: 'created', name: 'Sites', path: 'C:/Sites.yc' }; } };
  const created = await executeCreateProject({ name: 'Sites' }, workspace, 'chat-1');
  assert.deepEqual(calls, [{ name: 'Sites', adoptAgentConversationId: 'chat-1' }]);
  assert.equal(created.status, 'created');
  assert.match(created.note, /Every tool is available/);

  const cancelled = await executeCreateProject({ name: 'Sites' }, { hasProject: () => false, createProject: async () => ({ status: 'cancelled', feedback: 'closed' }) }, 'chat-1');
  assert.deepEqual(cancelled, { status: 'cancelled', feedback: 'closed' });
});
