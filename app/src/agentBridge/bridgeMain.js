/**
 * Main-process side of the Local Agent Bridge: keeps the on/off state and the token in userData/agent-bridge.json
 * (turning the bridge off discards the token, so every registered agent must re-register; while it stays on, the
 * token survives restarts),
 * starts and stops the MCP server, and forwards tool requests to the window, whose renderer runs the tools
 * (agentBridge/bridgeTools.js) and answers on 'agent-bridge:response'.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBridgeServer, newBridgeToken } from './bridgeServer.js';

const REQUEST_TIMEOUT_MS = 120000;

/**
 * @param {{ipcMain: object, getWindow: () => object|null, userDataDir: string, port?: number}} options
 */
export function createBridgeController({ ipcMain, getWindow, userDataDir, port }) {
  const file = path.join(userDataDir, 'agent-bridge.json');
  let state = { enabled: false, token: '' };
  let client = '';
  let lastTool = '';
  let lastCallAt = '';
  let error = '';
  const pending = new Map();

  ipcMain.on('agent-bridge:response', (_event, payload) => {
    const entry = pending.get(payload?.id);
    if (!entry) return;
    pending.delete(payload.id);
    clearTimeout(entry.timer);
    entry.resolve(payload.result);
  });

  function dispatch(request) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('The AnnoBio window is not open.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('AnnoBio did not answer in time.'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      win.webContents.send('agent-bridge:request', { id, ...request });
    });
  }

  const server = createBridgeServer({
    dispatch,
    port,
    getToken: () => state.token,
    onActivity: (event) => {
      if (event.client) client = event.client;
      else if (event.userAgent && !client) client = event.userAgent;
      if (event.tool) {
        lastTool = event.tool;
        lastCallAt = new Date().toISOString();
      }
    },
  });

  async function save() {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ enabled: state.enabled, token: state.token }), { mode: 0o600 });
  }

  function status() {
    return {
      enabled: state.enabled,
      running: server.running,
      port: server.port,
      url: server.running ? `http://127.0.0.1:${server.port}/mcp` : '',
      token: state.token,
      client,
      lastTool,
      lastCallAt,
      error,
    };
  }

  async function setEnabled(enabled) {
    state.enabled = Boolean(enabled);
    if (state.enabled) {
      if (!state.token) state.token = newBridgeToken();
      try {
        await server.start();
        error = '';
      } catch (startError) {
        error = startError instanceof Error ? startError.message : String(startError);
        state.enabled = false;
      }
    } else {
      await server.stop();
      client = '';
      state.token = '';  // off disconnects every agent for good; on again issues a new token
    }
    await save();
    return status();
  }

  return {
    async init() {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        state = { enabled: Boolean(saved.enabled), token: String(saved.token || '') };
      } catch (_) { /* first run: off */ }
      if (state.enabled) await setEnabled(true);
    },
    setEnabled,
    status,
    stop: () => server.stop(),
  };
}
