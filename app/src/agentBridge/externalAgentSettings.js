/**
 * Settings > External agent (desktop only): turn the Local Agent Bridge on or off, show its status, copy the
 * connection settings for Claude Code, Codex and Cursor, and reset the token. Changes apply at once (the tab has
 * no Save button). docs/design/LOCAL_AGENT_BRIDGE_DESIGN.md
 */

/** The panel's markup; settingsModal includes it only on the desktop app. */
export function externalAgentPanelHtml() {
  return `
                    <div class="review-detail-tab-panel" id="settings-panel-external-agent" role="tabpanel" aria-labelledby="settings-tab-external-agent" data-panel="external-agent">
                      <div class="defaults-page-scroll">
                          <p class="settings-tab-intro">Let a coding agent on this computer (Claude Code, Codex or Cursor) work with the project open in AnnoBio. You chat in the coding agent; it reads the project with the same tools as the Agent Assistant, and its own thinking uses its own subscription or quota. Running nodes still uses the models in your credentials. This version can read the project and try Process code; it cannot change the canvas or run nodes. Only programs on this computer that have the token can connect, and AnnoBio must be open.</p>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                                <input type="checkbox" id="settings-external-agent-enabled" aria-label="Allow coding agents on this computer to connect" />
                                Allow coding agents on this computer to connect
                              </label>
                              <div class="settings-agent-model-status" id="settings-external-agent-status" aria-live="polite">
                                <span class="settings-agent-model-status__text"></span>
                              </div>
                            </div>
                          </div>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <span class="dataset-meta-label">Connect a coding agent (once per agent)</span>
                              <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
                                <button type="button" class="btn btn-secondary" data-external-agent-copy="claude">Copy Claude Code command</button>
                                <button type="button" class="btn btn-secondary" data-external-agent-copy="codex">Copy Codex config</button>
                                <button type="button" class="btn btn-secondary" data-external-agent-copy="cursor">Copy Cursor config</button>
                                <button type="button" class="btn btn-secondary" id="settings-external-agent-reset">Reset token</button>
                              </div>
                              <p class="settings-tab-intro" style="margin-top:8px;">Claude Code: run the copied command in a terminal. Codex: paste the copied lines into ~/.codex/config.toml. Cursor: paste the copied JSON into Settings &gt; MCP (mcp.json). Then open a project here and ask your agent, for example, "use annobio to look at my project". Resetting the token disconnects every agent until you copy the new settings.</p>
                            </div>
                          </div>
                      </div>
                    </div>`;
}

/**
 * The text each coding agent needs to connect, for the bridge's current URL and token.
 * @param {{url: string, token: string}} status
 * @returns {{claude: string, codex: string, cursor: string}}
 */
export function bridgeConnectionSnippets({ url, token }) {
  const header = `Bearer ${token}`;
  return {
    claude: `claude mcp add --transport http annobio ${url} --header "Authorization: ${header}"`,
    codex: ['[mcp_servers.annobio]', `url = "${url}"`, `http_headers = { "Authorization" = "${header}" }`].join('\n'),
    cursor: JSON.stringify({ mcpServers: { annobio: { url, headers: { Authorization: header } } } }, null, 2),
  };
}

/** One line for the status area. */
export function bridgeStatusText(status) {
  if (!status) return 'Not available in this version.';
  if (status.error) return `Could not start: ${status.error}`;
  if (!status.enabled || !status.running) return 'Off. Coding agents cannot connect.';
  const last = status.lastTool ? ` Last request: ${status.lastTool}.` : '';
  const who = status.client ? ` Connected client: ${status.client}.` : ' No agent has connected yet.';
  return `On at ${status.url}.${who}${last}`;
}

/**
 * Wires the panel inside the Settings overlay.
 * @param {HTMLElement} overlay
 * @param {object} [api] window.electronAPI
 */
export function mountExternalAgentSettings(overlay, api = window.electronAPI) {
  const checkbox = overlay.querySelector('#settings-external-agent-enabled');
  const statusText = overlay.querySelector('#settings-external-agent-status .settings-agent-model-status__text');
  const resetButton = overlay.querySelector('#settings-external-agent-reset');
  const copyButtons = overlay.querySelectorAll('[data-external-agent-copy]');
  if (!checkbox || !api?.getAgentBridgeStatus) return;
  let status = null;

  function render() {
    checkbox.checked = Boolean(status?.enabled && status?.running);
    if (statusText) statusText.textContent = bridgeStatusText(status);
    const usable = Boolean(status?.running && status?.token);
    copyButtons.forEach((button) => { button.disabled = !usable; });
    if (resetButton) resetButton.disabled = !status?.token;
  }

  async function refresh() {
    try {
      status = await api.getAgentBridgeStatus();
    } catch (error) {
      status = { enabled: false, running: false, error: error instanceof Error ? error.message : String(error) };
    }
    render();
  }

  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    try {
      status = await api.setAgentBridgeEnabled(checkbox.checked);
    } finally {
      checkbox.disabled = false;
      render();
    }
  });
  resetButton?.addEventListener('click', async () => {
    status = await api.resetAgentBridgeToken();
    render();
  });
  copyButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      if (!status?.running) return;
      const text = bridgeConnectionSnippets(status)[button.dataset.externalAgentCopy];
      try {
        await navigator.clipboard.writeText(text);
        const label = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = label; }, 1500);
      } catch (_) {
        window.prompt('Copy this:', text);
      }
    });
  });
  void refresh();
  return { refresh };
}
