import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBridgeServer, handleMcpMessage } from '../src/agentBridge/bridgeServer.js';
import { BRIDGE_TOOL_NAMES, bridgeToolDefinitions, createBridgeToolHost } from '../src/agentBridge/bridgeTools.js';
import { CODING_AGENTS, bridgeConnectionSnippet, bridgeStatusText } from '../src/agentBridge/externalAgentSettings.js';
import { createBridgeController } from '../src/agentBridge/bridgeMain.js';
import { AGENT_TOOL_DEFINITIONS, USER_TOOLS } from '../src/agent/tools/agentTools.js';

function request(port, { method = 'POST', body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withServer(options, fn) {
  const server = createBridgeServer({ port: 0, getToken: () => 'secret', ...options });
  const port = await server.start();
  try {
    await fn(port);
  } finally {
    await server.stop();
  }
}

test('bridge refuses requests without the token, from a browser or for another host', async () => {
  await withServer({ dispatch: async () => [] }, async (port) => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await request(port, { body: ping })).status, 401);
    assert.equal((await request(port, { body: ping, token: 'wrong' })).status, 401);
    assert.equal((await request(port, { body: ping, token: 'secret', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(port, { body: ping, token: 'secret', headers: { Host: `evil.example:${port}` } })).status, 403);
    assert.equal((await request(port, { method: 'GET', token: 'secret' })).status, 405);
    const ok = await request(port, { body: ping, token: 'secret' });
    assert.deepEqual([ok.status, ok.body.result], [200, {}]);
  });
});

test('bridge speaks MCP: initialize, tools/list, tools/call and notifications', async () => {
  const calls = [];
  const activity = [];
  const dispatch = async (req) => {
    calls.push(req);
    if (req.kind === 'list') return [{ name: 'get_workspace', description: 'd', inputSchema: { type: 'object' } }];
    return req.name === 'get_workspace' ? { ok: true, content: 'summary' } : { ok: false, content: '{"error":"x"}' };
  };
  await withServer({ dispatch, onActivity: (e) => activity.push(e) }, async (port) => {
    const init = await request(port, { token: 'secret', body: { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } } });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'annobio');
    assert.match(init.body.result.instructions, /get_workspace/);
    const note = await request(port, { token: 'secret', body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(note.status, 202);
    const list = await request(port, { token: 'secret', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.equal(list.body.result.tools[0].name, 'get_workspace');
    const call = await request(port, { token: 'secret', body: { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_workspace', arguments: {} } } });
    assert.deepEqual(call.body.result, { content: [{ type: 'text', text: 'summary' }], isError: false });
    const bad = await request(port, { token: 'secret', body: { jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'nope', arguments: {} } } });
    assert.equal(bad.body.result.isError, true);
    const unknown = await request(port, { token: 'secret', body: { jsonrpc: '2.0', id: 5, method: 'resources/list' } });
    assert.equal(unknown.body.error.code, -32601);
  });
  assert.deepEqual(activity.filter((e) => e.client), [{ client: 'claude-code' }]);
  assert.deepEqual(calls.map((c) => c.kind), ['list', 'call', 'call']);
});

test('bridge rate-limits bursts', async () => {
  let t = 0;
  await withServer({ dispatch: async () => [], rateLimit: 2, now: () => t }, async (port) => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await request(port, { body: ping, token: 'secret' })).status, 200);
    assert.equal((await request(port, { body: ping, token: 'secret' })).status, 200);
    assert.equal((await request(port, { body: ping, token: 'secret' })).status, 429);
    t = 1500;
    assert.equal((await request(port, { body: ping, token: 'secret' })).status, 200);
  });
});

test('invalid JSON-RPC is rejected without calling tools', async () => {
  const response = await handleMcpMessage({ id: 1 }, { dispatch: async () => { throw new Error('not called'); } });
  assert.equal(response.error.code, -32600);
});

test('bridge tools: the Agent\'s read tools as they are, its card tools as previews, plus apply', () => {
  const tools = bridgeToolDefinitions();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.ok(!byName.has('ask_user'), 'the coding agent asks in its own chat');
  assert.ok(!byName.has('request_folder_access'));
  for (const tool of tools) {
    assert.ok(BRIDGE_TOOL_NAMES.has(tool.name), tool.name);
    if (tool.name === 'apply') continue;
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} changes nothing by itself`);
    if (tool.name === 'apply_status' || tool.name === 'create_project') continue;
    const original = AGENT_TOOL_DEFINITIONS.find((d) => d.function.name === tool.name).function;
    assert.deepEqual(tool.inputSchema, original.parameters);
    if (USER_TOOLS.has(tool.name)) assert.match(tool.description, /only PREVIEWS[\s\S]*call apply with the preview_id only after they agree/);
    else assert.equal(tool.description, original.description);
  }
  for (const name of ['propose_changes', 'run_nodes', 'pipeline_action', 'create_project']) assert.ok(byName.has(name), name);
  assert.equal(byName.get('apply').annotations.destructiveHint, true, 'clients ask before apply');
  assert.deepEqual(byName.get('apply').inputSchema.required, ['preview_id']);
});

test('tool host runs allowed tools with the Agent runtime and refuses the rest', async () => {
  const seen = [];
  const workspace = {
    hasProject: () => true,
    getCanvasState: () => ({ nodes: [], connections: [] }),
    inspectNode: async () => ({}),
    getScoreComparisonRows: async () => [],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  const execute = async (name, args, runtime) => {
    seen.push({ name, args, keys: Object.keys(runtime).sort() });
    return { ok: true, content: 'done' };
  };
  const host = createBridgeToolHost(() => workspace, { fetchImpl, execute });
  assert.deepEqual(await host.callTool('read_rows', { node_id: 'n1' }), { ok: true, content: 'done' });
  assert.deepEqual(seen[0].keys, ['buildSummary', 'getCanvasState', 'getScoreComparisonRows', 'inspectNode', 'signal']);
  const refused = await host.callTool('ask_user', {});
  assert.equal(refused.ok, false);
  assert.match(refused.content, /not available to external agents/);
  const noProject = createBridgeToolHost(() => ({ ...workspace, hasProject: () => false }), { fetchImpl, execute });
  assert.equal((await noProject.callTool('get_workspace', {})).ok, true);  // as the built-in Agent: works without a project
  assert.equal((await noProject.callTool('read_guide', { topic: 'x' })).ok, true);
  const needsProject = await noProject.callTool('read_rows', { node_id: 'n1' });
  assert.equal(needsProject.ok, false);
  assert.match(needsProject.content, /needs a project/);
  assert.match((await noProject.callTool('run_nodes', { jobs: [] })).content, /needs a project/);
});

/** A tool host whose preview / execute functions are fakes over a mutable canvas. */
function previewHost({ applyWaitMs = 1000, execute } = {}) {
  const state = { canvas: 'a', project: 'p1', executed: [], open: true };
  const workspace = {
    hasProject: () => state.open,
    getAssetProjectId: () => state.project,
    getCanvasState: () => ({ nodes: [], connections: [] }),
    inspectNode: async () => ({}),
  };
  const preview = async (request) => (request.bad ? { ok: false, error: 'bad request' }
    : { ok: true, items: [{ kind: 'add', title: `Add on ${state.canvas}`, lines: ['one line'], nodeIds: ['x'] }], total: request.jobs ? 'Estimated cost: about $0.10' : undefined });
  const actions = () => ({
    preview: { proposal: preview, run: preview, pipeline: preview, project: preview },
    execute: {
      proposal: async (request, approved) => { state.executed.push(['proposal', request, approved]); return { status: 'applied', changes: ['added'] }; },
      run: execute || (async (request) => { state.executed.push(['run', request]); return { status: 'completed', results: ['done'] }; }),
      pipeline: async () => ({ status: 'renamed' }),
      project: async () => ({ status: 'created', name: 'New' }),
    },
  });
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  return { state, host: createBridgeToolHost(() => workspace, { fetchImpl, actions, applyWaitMs }) };
}

test('preview changes nothing; apply does exactly the previewed request, once', async () => {
  const { state, host } = previewHost();
  const request = { summary: 'Add a prompt', operations: [{ op: 'add_prompt' }] };
  const shown = await host.callTool('propose_changes', request);
  assert.equal(shown.ok, true);
  const body = JSON.parse(shown.content);
  assert.match(body.preview_id, /^proposal-/);
  assert.deepEqual(body.what_will_happen, [{ title: 'Add on a', lines: ['one line'] }]);
  assert.equal(body.nothing_changed_yet, true);
  assert.equal(state.executed.length, 0, 'previewing changes nothing');
  const done = await host.callTool('apply', { preview_id: body.preview_id });
  assert.equal(done.ok, true);
  assert.equal(JSON.parse(done.content).status, 'applied');
  assert.deepEqual(state.executed[0][1], request);
  const again = await host.callTool('apply', { preview_id: body.preview_id });
  assert.equal(again.ok, false);
  assert.match(again.content, /already applied/);
  assert.equal(state.executed.length, 1);
  assert.match((await host.callTool('apply', { preview_id: 'nope' })).content, /Unknown or expired/);
  const invalid = await host.callTool('propose_changes', { bad: true });
  assert.equal(invalid.ok, false);
  assert.match(invalid.content, /Not previewed: bad request/);
  const run = JSON.parse((await host.callTool('run_nodes', { summary: 's', jobs: [{ kind: 'run', node: 'g' }] })).content);
  assert.equal(run.estimate, 'Estimated cost: about $0.10');
});

test('apply refuses when the canvas or the open project changed since the preview', async () => {
  const { state, host } = previewHost();
  const first = JSON.parse((await host.callTool('propose_changes', { operations: [] })).content).preview_id;
  state.canvas = 'b';
  const stale = await host.callTool('apply', { preview_id: first });
  assert.equal(stale.ok, false);
  assert.match(stale.content, /changed since this preview/);
  const second = JSON.parse((await host.callTool('propose_changes', { operations: [] })).content).preview_id;
  state.project = 'p2';
  assert.match((await host.callTool('apply', { preview_id: second })).content, /different project/);
  assert.equal(state.executed.length, 0);
});

test('a long run answers "running"; apply_status follows it; only a stop may start meanwhile', async () => {
  let finish;
  const execute = (request) => (request.jobs[0].kind === 'stop'
    ? Promise.resolve({ status: 'completed', results: ['stop requested'] })
    : new Promise((resolve) => { finish = () => resolve({ status: 'completed', results: ['10 rows'] }); }));
  const { host } = previewHost({ applyWaitMs: 20, execute });
  const id = JSON.parse((await host.callTool('run_nodes', { jobs: [{ kind: 'run', node: 'g' }] })).content).preview_id;
  const started = JSON.parse((await host.callTool('apply', { preview_id: id })).content);
  assert.equal(started.status, 'running');
  assert.equal(JSON.parse((await host.callTool('apply_status', {})).content).preview_id, id);
  const other = JSON.parse((await host.callTool('propose_changes', { operations: [] })).content).preview_id;
  assert.match((await host.callTool('apply', { preview_id: other })).content, /still running/);
  const stop = JSON.parse((await host.callTool('run_nodes', { jobs: [{ kind: 'stop', node: 'g' }] })).content).preview_id;
  assert.equal(JSON.parse((await host.callTool('apply', { preview_id: stop })).content).status, 'completed');
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const ended = await host.callTool('apply_status', { preview_id: id });
  assert.equal(ended.ok, true);
  assert.deepEqual(JSON.parse(ended.content).results, ['10 rows']);
  assert.equal(JSON.parse((await host.callTool('apply_status', {})).content).status, 'idle');
});

test('without a project, create_project previews and applies; other previews need a project', async () => {
  const { state, host } = previewHost();
  state.open = false;
  state.project = null;
  const id = JSON.parse((await host.callTool('create_project', { name: 'New', summary: 's' })).content).preview_id;
  assert.match(id, /^project-/);
  const created = await host.callTool('apply', { preview_id: id });
  assert.equal(created.ok, true);
  assert.equal(JSON.parse(created.content).status, 'created');
  assert.match((await host.callTool('propose_changes', { operations: [] })).content, /needs a project/);
});

test('the dropdown offers Claude Code, Codex and Cursor, each with its own connection text', () => {
  assert.deepEqual(CODING_AGENTS.map((a) => a.label), ['Claude Code', 'Codex', 'Cursor']);
  const status = { url: 'http://127.0.0.1:47321/mcp', token: 'abc' };
  const s = Object.fromEntries(CODING_AGENTS.map((a) => [a.id, bridgeConnectionSnippet(a.id, status)]));
  assert.equal(bridgeConnectionSnippet('unknown', status), '');
  assert.equal(s.claude, 'claude mcp add --transport http annobio http://127.0.0.1:47321/mcp --header "Authorization: Bearer abc"');
  assert.match(s.codex, /^\[mcp_servers\.annobio\]\nurl = "http:\/\/127\.0\.0\.1:47321\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer abc" \}$/);
  assert.deepEqual(JSON.parse(s.cursor), { mcpServers: { annobio: { url: 'http://127.0.0.1:47321/mcp', headers: { Authorization: 'Bearer abc' } } } });
  assert.match(bridgeStatusText({ enabled: false, running: false }), /^Not connected/);
  assert.match(bridgeStatusText({ enabled: true, running: true, url: 'u', client: 'codex' }), /codex/);
  assert.match(bridgeStatusText({ enabled: true, running: true, url: 'u', lastTool: 'read_rows' }), /An agent is connected/);
  assert.doesNotMatch(bridgeStatusText({ enabled: true, running: true, url: 'u', client: 'codex', lastTool: 'read_rows' }), /read_rows|Last request/);
});

test('controller persists the switch and token, and round-trips a request through the window', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-'));
  const listeners = {};
  const ipcMain = { on: (channel, fn) => { listeners[channel] = fn; } };
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, req) => {
        assert.equal(channel, 'agent-bridge:request');
        setImmediate(() => listeners['agent-bridge:response'](null, { id: req.id, result: req.kind === 'list' ? [] : { ok: true, content: `ran ${req.name}` } }));
      },
    },
  };
  const controller = createBridgeController({ ipcMain, getWindow: () => window, userDataDir: dir, port: 0 });
  await controller.init();
  assert.equal(controller.status().running, false);
  const on = await controller.setEnabled(true);
  assert.equal(on.running, true);
  assert.equal(on.token.length, 64);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'agent-bridge.json'), 'utf8'));
  assert.deepEqual(saved, { enabled: true, token: on.token });
  const call = await request(on.port, { token: on.token, headers: { 'User-Agent': 'claude-code/2.0 (cli)' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_workspace', arguments: {} } } });
  assert.equal(call.body.result.content[0].text, 'ran get_workspace');
  assert.equal(controller.status().client, 'claude-code/2.0');  // no initialize: named by its User-Agent
  const off = await controller.setEnabled(false);
  assert.equal(off.running, false);
  assert.equal(off.token, '');  // off discards the token
  const again = await controller.setEnabled(true);
  assert.notEqual(again.token, on.token);  // on again: a new token, the old one no longer works
  assert.equal((await request(again.port, { token: on.token, body: { jsonrpc: '2.0', id: 2, method: 'ping' } })).status, 401);
  assert.equal((await request(again.port, { token: again.token, body: { jsonrpc: '2.0', id: 3, method: 'ping' } })).status, 200);
  const restarted = createBridgeController({ ipcMain, getWindow: () => window, userDataDir: dir, port: 0 });
  await controller.stop();
  await restarted.init();  // still on after a restart: same token, no re-registration
  assert.equal(restarted.status().token, again.token);
  assert.equal(restarted.status().running, true);
  await restarted.stop();
  await controller.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('settings panel: only a dropdown and a copy button; the first copy opens the connection', async () => {
  const { externalAgentPanelHtml, mountExternalAgentSettings } = await import('../src/agentBridge/externalAgentSettings.js');
  const html = externalAgentPanelHtml();
  assert.ok(!html.includes('type="checkbox"'), 'no on/off switch');
  assert.ok(!/Disconnect|Reset token/.test(html), 'no disconnect or reset button');
  assert.match(html, /Copy connection settings/);
  const make = () => ({ hidden: false, disabled: false, textContent: '', value: 'claude', listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; } });
  const els = { '#settings-external-agent-status .settings-agent-model-status__text': make(),
    '#settings-external-agent-client': make(), '#settings-external-agent-copy': make(),
    '#settings-external-agent-howto': make() };
  const overlay = { querySelector: (sel) => els[sel] || null };
  let state = { enabled: false, running: false, token: '' };
  const calls = [];
  const api = {
    getAgentBridgeStatus: async () => state,
    setAgentBridgeEnabled: async (on) => {
      calls.push(on);
      state = { enabled: true, running: true, token: 't', url: 'http://127.0.0.1:47321/mcp' };
      return state;
    },
  };
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
  mountExternalAgentSettings(overlay, api);
  await new Promise((r) => setImmediate(r));
  await els['#settings-external-agent-copy'].listeners.click();
  await els['#settings-external-agent-copy'].listeners.click();
  assert.deepEqual(calls, [true]);  // opened once; the second copy only copies
  assert.equal(copied.length, 2);
  assert.match(copied[0], /^claude mcp add --transport http annobio http:\/\/127\.0\.0\.1:47321\/mcp/);
});

test('evaluation metrics with only precision / recall / F1 read cleanly (no undefined or NaN)', async () => {
  const { formatScoreMetrics } = await import('../src/agent/canvas/scoreComparisonPrf.js');
  assert.equal(formatScoreMetrics({ precision: 6.6, recall: 50, f1: 11.6 }), 'precision 6.6%, recall 50%, F1 11.6%');
  assert.equal(formatScoreMetrics({ matchedRows: 3, totalRows: 4, passRate: 0.75 }), '3/4 rows matched (75%)');
  assert.equal(formatScoreMetrics({}), 'no comparison result yet');
});

test('the external agent\'s workspace summary leaves out the folder-permission hint', async () => {
  const { buildWorkspaceSummary } = await import('../src/agent/context/workspaceSummary.js');
  const options = { projectPath: 'C:/Users/me/p.yc', projectOpen: true, credentialsById: new Map(), defaultRunCredential: null,
    extractInputFields: () => [], inspectNode: async () => ({}) };
  const state = { nodes: [], connections: [] };
  assert.match(await buildWorkspaceSummary(state, options), /request_folder_access/);
  const external = await buildWorkspaceSummary(state, { ...options, folderAccessTool: false });
  assert.doesNotMatch(external, /request_folder_access/);
});
