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

test('bridge tools are the built-in Agent\'s read-only tools, with the same definitions', () => {
  const tools = bridgeToolDefinitions();
  const agentNames = new Set(AGENT_TOOL_DEFINITIONS.map((d) => d.function.name));
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(agentNames.has(tool.name), tool.name);
    assert.ok(BRIDGE_TOOL_NAMES.has(tool.name));
    assert.ok(!USER_TOOLS.has(tool.name), `${tool.name} needs confirmation and must not be offered in B1`);
    const original = AGENT_TOOL_DEFINITIONS.find((d) => d.function.name === tool.name).function;
    assert.equal(tool.description, original.description);
    assert.deepEqual(tool.inputSchema, original.parameters);
  }
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
  const refused = await host.callTool('propose_changes', {});
  assert.equal(refused.ok, false);
  assert.match(refused.content, /not available to external agents/);
  const noProject = createBridgeToolHost(() => ({ ...workspace, hasProject: () => false }), { fetchImpl, execute });
  assert.match((await noProject.callTool('get_workspace', {})).content, /No project is open/);
  assert.equal((await noProject.callTool('read_guide', { topic: 'x' })).ok, true);
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
  const call = await request(on.port, { token: on.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_workspace', arguments: {} } } });
  assert.equal(call.body.result.content[0].text, 'ran get_workspace');
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

test('settings panel: the first copy opens the connection; Disconnect all agents closes it', async () => {
  const { externalAgentPanelHtml, mountExternalAgentSettings } = await import('../src/agentBridge/externalAgentSettings.js');
  const html = externalAgentPanelHtml();
  assert.ok(!html.includes('type="checkbox"'), 'no on/off switch');
  assert.match(html, /Copy connection settings/);
  assert.match(html, /Disconnect all agents/);
  // A minimal DOM stand-in for the elements the panel wires.
  const make = () => ({ hidden: false, disabled: false, textContent: '', value: 'claude', listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; } });
  const els = { '#settings-external-agent-status .settings-agent-model-status__text': make(),
    '#settings-external-agent-client': make(), '#settings-external-agent-copy': make(),
    '#settings-external-agent-howto': make(), '#settings-external-agent-disconnect': make() };
  const overlay = { querySelector: (sel) => els[sel] || null };
  let state = { enabled: false, running: false, token: '' };
  const calls = [];
  const api = {
    getAgentBridgeStatus: async () => state,
    setAgentBridgeEnabled: async (on) => {
      calls.push(on);
      state = on ? { enabled: true, running: true, token: 't', url: 'http://127.0.0.1:47321/mcp' } : { enabled: false, running: false, token: '' };
      return state;
    },
  };
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
  mountExternalAgentSettings(overlay, api);
  await new Promise((r) => setImmediate(r));
  assert.equal(els['#settings-external-agent-disconnect'].hidden, true);
  await els['#settings-external-agent-copy'].listeners.click();
  assert.deepEqual(calls, [true]);
  assert.match(copied[0], /^claude mcp add --transport http annobio http:\/\/127\.0\.0\.1:47321\/mcp/);
  assert.equal(els['#settings-external-agent-disconnect'].hidden, false);
  await els['#settings-external-agent-disconnect'].listeners.click();
  assert.deepEqual(calls, [true, false]);
  assert.equal(els['#settings-external-agent-disconnect'].hidden, true);
});
