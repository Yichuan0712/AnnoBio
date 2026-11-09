/**
 * Settings > External agent (desktop only): a dropdown picks the coding agent and "Copy connection settings" copies
 * its settings, turning the Local Agent Bridge on the first time. "Disconnect all agents" turns it off and discards
 * the token, so every agent must register again. No other control (user decision 2026-11-08). Changes apply at once
 * (the tab has no Save button). docs/design/LOCAL_AGENT_BRIDGE_DESIGN.md
 */

const STATUS_REFRESH_MS = 2000;

/** Coding agents in the dropdown, in order. Adding one = one entry here. */
export const CODING_AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    howTo: 'Run the copied command once in a terminal.',
    snippet: ({ url, header }) => `claude mcp add --transport http annobio ${url} --header "Authorization: ${header}"`,
  },
  {
    id: 'codex',
    label: 'Codex',
    howTo: 'Paste the copied lines into ~/.codex/config.toml.',
    snippet: ({ url, header }) => ['[mcp_servers.annobio]', `url = "${url}"`, `http_headers = { "Authorization" = "${header}" }`].join('\n'),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    howTo: 'Paste the copied JSON into Cursor Settings > MCP (mcp.json).',
    snippet: ({ url, header }) => JSON.stringify({ mcpServers: { annobio: { url, headers: { Authorization: header } } } }, null, 2),
  },
];

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** The panel's markup; settingsModal includes it only on the desktop app. */
export function externalAgentPanelHtml() {
  const options = CODING_AGENTS.map((agent) => `<option value="${agent.id}">${escapeHtml(agent.label)}</option>`).join('');
  return `
                    <div class="review-detail-tab-panel" id="settings-panel-external-agent" role="tabpanel" aria-labelledby="settings-tab-external-agent" data-panel="external-agent">
                      <div class="defaults-page-scroll">
                          <p class="settings-tab-intro">Let a coding agent on this computer work with the project open in AnnoBio. You chat in the coding agent; it reads the project with the same tools as the Agent Assistant, and its own thinking uses its own subscription or quota. Running nodes still uses the models in your credentials. This version can read the project and try Process code; it cannot change the canvas or run nodes.</p>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-external-agent-client">Connect</label>
                              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                                <select id="settings-external-agent-client" class="credentials-select dataset-meta-input" style="max-width:220px;" aria-label="Coding agent to connect">${options}</select>
                                <button type="button" class="btn btn-secondary" id="settings-external-agent-copy">Copy connection settings</button>
                                <button type="button" class="btn btn-secondary" id="settings-external-agent-disconnect" hidden>Disconnect all agents</button>
                              </div>
                              <div class="settings-agent-model-status" id="settings-external-agent-status" aria-live="polite" style="margin-top:6px;">
                                <span class="settings-agent-model-status__text"></span>
                              </div>
                              <p class="settings-tab-intro" id="settings-external-agent-howto" style="margin-top:8px;"></p>
                            </div>
                          </div>
                      </div>
                    </div>`;
}

/**
 * The text a coding agent needs to connect, for the bridge's current URL and token.
 * @param {string} agentId one of CODING_AGENTS
 * @param {{url: string, token: string}} status
 */
export function bridgeConnectionSnippet(agentId, { url, token }) {
  const agent = CODING_AGENTS.find((item) => item.id === agentId);
  return agent ? agent.snippet({ url, header: `Bearer ${token}` }) : '';
}

/** One line for the status area. */
export function bridgeStatusText(status) {
  if (!status) return 'Not available in this version.';
  if (status.error) return `Could not start: ${status.error}`;
  if (!status.enabled || !status.running) return 'Not connected. Copy connection settings to let a coding agent connect.';
  const last = status.lastTool ? ` Last request: ${status.lastTool}.` : '';
  const who = status.client ? ` Connected: ${status.client}.` : ' No agent has connected yet.';
  return `On at ${status.url}.${who}${last}`;
}

/**
 * Wires the panel inside the Settings overlay.
 * @param {HTMLElement} overlay
 * @param {object} [api] window.electronAPI
 */
export function mountExternalAgentSettings(overlay, api = window.electronAPI) {
  const statusText = overlay.querySelector('#settings-external-agent-status .settings-agent-model-status__text');
  const select = overlay.querySelector('#settings-external-agent-client');
  const copyButton = overlay.querySelector('#settings-external-agent-copy');
  const howTo = overlay.querySelector('#settings-external-agent-howto');
  const disconnectButton = overlay.querySelector('#settings-external-agent-disconnect');
  if (!select || !copyButton || !api?.getAgentBridgeStatus) return;
  let status = null;

  function render() {
    const on = Boolean(status?.enabled && status?.running);
    if (statusText) statusText.textContent = bridgeStatusText(status);
    if (disconnectButton) disconnectButton.hidden = !on;
    const agent = CODING_AGENTS.find((item) => item.id === select.value) || CODING_AGENTS[0];
    if (howTo) {
      howTo.textContent = `${agent.howTo} Then open a project here and ask your agent, for example, "use annobio to look `
        + 'at my project". Only programs on this computer with these settings can connect; Disconnect all agents '
        + 'cuts every agent off, and the next copy gives new settings to register again.';
    }
  }

  async function refresh() {
    try {
      status = await api.getAgentBridgeStatus();
    } catch (error) {
      status = { enabled: false, running: false, error: error instanceof Error ? error.message : String(error) };
    }
    render();
  }

  disconnectButton?.addEventListener('click', async () => {
    disconnectButton.disabled = true;
    try {
      status = await api.setAgentBridgeEnabled(false);
    } finally {
      disconnectButton.disabled = false;
      render();
    }
  });
  select.addEventListener('change', render);
  copyButton.addEventListener('click', async () => {
    if (!status?.running || !status?.token) {
      copyButton.disabled = true;
      try {
        status = await api.setAgentBridgeEnabled(true);  // the first copy opens the connection
      } finally {
        copyButton.disabled = false;
        render();
      }
      if (!status?.running || !status?.token) return;
    }
    const text = bridgeConnectionSnippet(select.value, status);
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copied';
      setTimeout(() => { copyButton.textContent = 'Copy connection settings'; }, 1500);
    } catch (_) {
      window.prompt('Copy this:', text);
    }
  });
  void refresh();
  // Keep the status line current (a client connecting, its last request) while this tab is showing; stops once the
  // Settings window is closed.
  const panel = overlay.querySelector?.('#settings-panel-external-agent');
  const timer = setInterval(() => {
    if (!overlay.isConnected) {
      clearInterval(timer);
      return;
    }
    if (panel?.classList?.contains('review-detail-tab-panel--active')) void refresh();
  }, STATUS_REFRESH_MS);
  return { refresh };
}
