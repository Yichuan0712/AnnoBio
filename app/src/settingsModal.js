/**
 * Model settings modal: credentials table (left, always visible); Runner / Reviewer / add-credentials (right tabs).
 * APIs: /api/credentials, /api/settings.
 */

import { showAlert, showConfirm } from './alertModal.js';
import { selectPlaceholderLabel } from './displayTextNormalize.js';
import { BACKEND_API_BASE } from './backendConfig.js';

const API_BASE = BACKEND_API_BASE;

const PROVIDER_LABELS = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  bedrock: 'Bedrock',
};

/** Must stay aligned with backend DEFAULT_SETTINGS in main.py */
const MODEL_SETTINGS_DEFAULTS = {
  default_run_credential_id: '',
  default_review_credential_id: '',
  default_agent_credential_id: '',
  run_max_tokens: 8192,
  review_max_tokens: 32768,
  run_max_retries: 2,
  /** Rows within a single Run job processed concurrently (1-10). */
  run_concurrency: 4,
  /** Registered review method id (backend/review_methods.py); blank = registry default. */
  default_review_method: '',
  /** GEPA reflective-evolution max iterations (4-200); separate from optimization_max_trials because
   * each GEPA iteration runs the task model against every targeted input, not just a suggestion's rows. */
  gepa_max_iterations: 15,
  /** MIPROv2 trials (4-200); its own setting for the same reason as gepa_max_iterations. */
  miprov2_num_trials: 10,
  /** BootstrapFewShotWithRandomSearch candidate demo sets (2-100); own setting, same reason. */
  bootstrap_fewshot_num_candidates: 10,
  /** TextGrad textual-gradient-descent steps (2-50); own setting, same reason. */
  textgrad_num_steps: 6,
  /** COPRO instruction variants per round (2-30) and coordinate-ascent rounds (1-10); own settings, same reason. */
  copro_breadth: 6,
  copro_depth: 3,
  /** SIMBA mini-batch introspection steps (2-40); own setting, same reason. */
  simba_max_steps: 8,
  /** Distinct inputs with ≥1 unmatched comparison row; Phase 1 analyzes at most this many. */
  review_max_failed_rows: 30,
  /** Thompson-sampling trials per compositional optimization run (4–200). */
  optimization_max_trials: 40,
  /** Show Reset & Debug buttons on suggestion cards. */
  debug_mode: false,
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* ——— Credentials panel (table left, add form right) ——— */

function getCredTbody(scope) {
  return scope.querySelector('.credentials-table tbody');
}

function credentialModelLabel(credential) {
  return credential?.model || credential?.llm || '—';
}

function credentialSourceBadge(c) {
  const isOpenRouter = c.provider === 'openrouter';
  const label = isOpenRouter ? 'OpenRouter' : 'LiteLLM';
  const kind = isOpenRouter ? 'openrouter' : 'litellm';
  return `<span class="credential-source-badge credential-source-badge--${kind}">${label}</span>`;
}

function credentialStatusIcon(c) {
  if (c.last_check_ok === true) {
    const label = PROVIDER_LABELS[c.provider] || c.provider || 'Verified';
    return `<span class="credential-status-icon credential-status-icon--ok" data-status-icon="${c.id}" title="Verified: ${escapeHtml(label)}">✓</span>`;
  }
  if (c.last_check_ok === false) {
    const msg = c.last_check_error || 'Verification failed';
    return `<span class="credential-status-icon credential-status-icon--error" data-status-icon="${c.id}" title="${escapeHtml(msg)}">✗</span>`;
  }
  return `<span class="credential-status-icon" data-status-icon="${c.id}" title="Not verified yet — click Test"></span>`;
}

function renderCredentialsTable(scope, list) {
  const tbody = getCredTbody(scope);
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="4">No credentials added yet.</td></tr>';
    return;
  }
  const maskedPlaceholder = '••••••••';
  tbody.innerHTML = list.map((c) => `
    <tr data-credential-id="${c.id}">
      <td>${escapeHtml(credentialModelLabel(c))} ${credentialSourceBadge(c)} ${credentialStatusIcon(c)}</td>
      <td class="credentials-provider-cell">${escapeHtml(c.base_url || 'Default')}</td>
      <td class="credentials-key-cell">
        <code class="credentials-key-value">${maskedPlaceholder}</code>
      </td>
      <td class="credentials-actions-cell">
        <div class="credentials-actions-inline">
          <button type="button" class="btn btn-secondary credentials-test-btn" data-id="${c.id}" aria-label="Test">Test</button>
          <button type="button" class="btn btn-secondary credentials-delete-btn" data-id="${c.id}" aria-label="Delete">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function fetchCredentialsStrict() {
  const res = await fetch(`${API_BASE}/api/credentials`);
  if (!res.ok) throw new Error('Failed to load credentials');
  return res.json();
}

async function loadAndRenderCredentials(scope) {
  try {
    const list = await fetchCredentialsStrict();
    renderCredentialsTable(scope, list);
    bindCredKeyCellClick(scope);
    bindCredTestButtons(scope);
    bindCredDeleteButtons(scope);
  } catch (e) {
    console.error('Load credentials:', e);
    const tbody = getCredTbody(scope);
    if (tbody) tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="4">Unable to load (is the backend running?).</td></tr>';
  }
}

function notifyCredentialsPanelChanged(el) {
  const panel = el?.closest?.('.credentials-panel-host');
  panel?._onCredentialsChange?.();
}

const MASKED_PLACEHOLDER = '••••••••';

function openCredKeyViewInCell(id, keyCell) {
  if (keyCell.querySelector('.credentials-cell-edit-wrap')) return;
  const wrap = document.createElement('div');
  wrap.className = 'credentials-cell-edit-wrap credentials-cell-key-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.setAttribute('aria-label', 'API key');
  input.value = 'Loading…';
  const doClose = () => {
    input.value = '';
    wrap.remove();
    const code = document.createElement('code');
    code.className = 'credentials-key-value';
    code.textContent = MASKED_PLACEHOLDER;
    keyCell.textContent = '';
    keyCell.appendChild(code);
  };
  input.addEventListener('blur', doClose);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); doClose(); }
  });
  wrap.appendChild(input);
  keyCell.textContent = '';
  keyCell.appendChild(wrap);
  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/credentials/${id}`);
      if (!res.ok) throw new Error('Failed to load key');
      const data = await res.json();
      input.value = data.api_key ?? '';
      input.focus();
    } catch (e) {
      console.error('Load full key:', e);
      input.value = 'Failed to load.';
    }
  })();
}

function bindCredKeyCellClick(scope) {
  scope.querySelectorAll('.credentials-key-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const row = cell.closest('tr');
      const id = row?.getAttribute('data-credential-id');
      if (!id) return;
      openCredKeyViewInCell(id, cell);
    });
  });
}

function setCredentialStatusIcon(scope, id, { symbol, title, kind }) {
  const icon = scope.querySelector(`[data-status-icon="${id}"]`);
  if (!icon) return;
  icon.textContent = symbol;
  icon.title = title || '';
  icon.classList.toggle('credential-status-icon--ok', kind === 'ok');
  icon.classList.toggle('credential-status-icon--error', kind === 'error');
  icon.classList.toggle('credential-status-icon--pending', kind === 'pending');
}

/**
 * The one real check: sends a minimal chat completion under candidate provider
 * interpretations (see backend verify_credential) and, if one succeeds, corrects the
 * credential's stored provider. Used by both the table's Test button and the
 * fire-and-forget check that runs right after Add -- same endpoint, same result rendering
 * (a green check or red cross right after the model name).
 */
async function runCredentialCheck(scope, id) {
  setCredentialStatusIcon(scope, id, { symbol: '', title: 'Checking…', kind: 'pending' });
  try {
    const res = await fetch(`${API_BASE}/api/credentials/${id}/test`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const label = PROVIDER_LABELS[data.provider] || data.provider || 'Verified';
      setCredentialStatusIcon(scope, id, { symbol: '✓', title: `Verified: ${label}`, kind: 'ok' });
      return true;
    } else {
      const msg = typeof data.detail === 'string' ? data.detail : (data.error || 'Failed');
      setCredentialStatusIcon(scope, id, { symbol: '✗', title: msg, kind: 'error' });
      return false;
    }
  } catch (e) {
    setCredentialStatusIcon(scope, id, { symbol: '✗', title: (e && e.message) || 'Network error', kind: 'error' });
    return false;
  }
}

function bindCredTestButtons(scope) {
  scope.querySelectorAll('.credentials-test-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  scope.querySelectorAll('.credentials-test-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      btn.disabled = true;
      try {
        await runCredentialCheck(scope, id);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function makeCachedCatalogLoader(path) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = fetch(`${API_BASE}${path}`)
        .then((res) => {
          if (!res.ok) throw new Error('Failed to load model catalog');
          return res.json();
        })
        .then((data) => (Array.isArray(data.models) ? data.models : []))
        .catch((e) => {
          promise = null; // allow retry on next open
          throw e;
        });
    }
    return promise;
  };
}

const loadOpenRouterCatalog = makeCachedCatalogLoader('/api/credentials/openrouter/catalog');
const loadLiteLlmCatalog = makeCachedCatalogLoader('/api/credentials/litellm/catalog');

function formatModelPrice(perToken) {
  const n = Number(perToken);
  if (!Number.isFinite(n) || n <= 0) return 'free';
  return `$${(n * 1_000_000).toFixed(2)}/M`;
}

function defaultModelPickerMeta(m) {
  const priceBit = (m.prompt_price != null || m.completion_price != null)
    ? ` · ${formatModelPrice(m.prompt_price)} in / ${formatModelPrice(m.completion_price)} out`
    : '';
  return `${escapeHtml(m.id)}${priceBit}`;
}

/**
 * Generic "pick a model from a list" overlay, shared by the OpenRouter "Add model" flow and
 * the LiteLLM "Choose model" flow. `loadModels()` resolves to [{id, name, vision?, ...}].
 * `onPick(modelId, close)` decides what happens with the choice and closes on success.
 */
async function openModelPicker({ loadModels, onPick, renderMeta = defaultModelPickerMeta, renderTitle = (m) => m.name || m.id, title = 'Choose a model' }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--openrouter-models">
      <div class="modal-header">
        <h2 class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body openrouter-model-picker-body">
        <input type="text" class="dataset-meta-input openrouter-model-picker-filter" placeholder="Search models…" aria-label="Search models" autocomplete="off" />
        <div class="openrouter-model-picker-list" aria-busy="true">Loading models…</div>
      </div>
    </div>
  `;
  const close = () => { overlay.remove(); document.body.style.overflow = ''; };
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  const filterInput = overlay.querySelector('.openrouter-model-picker-filter');
  const listEl = overlay.querySelector('.openrouter-model-picker-list');

  let models = [];
  try {
    models = await loadModels();
  } catch (e) {
    listEl.textContent = (e && e.message) || 'Could not load models.';
    return;
  }

  function renderList(filterText) {
    const q = filterText.trim().toLowerCase();
    const matches = q ? models.filter((m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)) : models;
    if (matches.length === 0) {
      listEl.innerHTML = '<p class="openrouter-model-picker-empty">No matching models.</p>';
      return;
    }
    listEl.innerHTML = matches.slice(0, 200).map((m) => `
      <button type="button" class="openrouter-model-picker-row" data-model-id="${escapeHtml(m.id)}">
        <span class="openrouter-model-picker-row-name">${escapeHtml(renderTitle(m))}${m.vision ? ' 🖼' : ''}${m.pdf ? ' 📄' : ''}</span>
        <span class="openrouter-model-picker-row-meta">${renderMeta(m)}</span>
      </button>
    `).join('');
    listEl.querySelectorAll('.openrouter-model-picker-row').forEach((row) => {
      row.addEventListener('click', () => onPick(row.getAttribute('data-model-id'), close));
    });
  }

  listEl.setAttribute('aria-busy', 'false');
  renderList('');
  filterInput.addEventListener('input', () => renderList(filterInput.value));
  filterInput.focus();
}

function bindCredDeleteButtons(scope) {
  scope.querySelectorAll('.credentials-delete-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  scope.querySelectorAll('.credentials-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      const ok = await showConfirm('Delete this credential?', { title: 'Delete credential', confirmText: 'Delete' });
      if (!ok) return;
      try {
        const res = await fetch(`${API_BASE}/api/credentials/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadAndRenderCredentials(scope);
        notifyCredentialsPanelChanged(btn);
      } catch (e) {
        console.error('Delete credential:', e);
      }
    });
  });
}

/**
 * Left column: credentials table only.
 * @param {HTMLElement} tableHost
 * @param {{ onCredentialsChange?: () => void }} [options]
 * @returns {Promise<void>}
 */
function mountCredentialsTableHost(tableHost, options = {}) {
  tableHost.classList.add('credentials-panel-host');
  tableHost.innerHTML = `
    <div class="credentials-panel-inner">
      <div class="credentials-prompt-block credentials-prompt-block--table">
        <div class="credentials-table-scroll">
          <table class="credentials-table" aria-label="Model credentials">
            <thead>
              <tr>
                <th>Model</th>
                <th>API Base</th>
                <th>API key</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr class="credentials-table-empty">
                <td colspan="4">No credentials added yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  tableHost._onCredentialsChange = typeof options.onCredentialsChange === 'function' ? options.onCredentialsChange : undefined;

  return (async () => {
    await loadAndRenderCredentials(tableHost);
  })();
}

/**
 * Add-credential form in Settings tab; submit via #settings-footer-add in the modal footer.
 *
 * Saving is always instant -- it never waits on a network call to some LLM provider.
 * Figuring out which provider a model id/key actually belongs to happens in two places,
 * neither of which blocks Add:
 * - On blur: a free, unauthoritative probe (/api/credentials/detect) that only lists models
 *   for the Model ID autocomplete dropdown. It can't prove anything (some list endpoints,
 *   like OpenRouter's, don't even require a valid key), so it never decides what gets saved.
 * - Right after a successful save: the same real check as the table's Test button
 *   (runCredentialCheck, POST /api/credentials/{id}/test), fired in the background so it
 *   never blocks Add, with its result rendered in the credentials table's Status column --
 *   not here in the add form -- so there is exactly one place that shows "is this really
 *   OpenRouter/OpenAI/...".
 * @param {HTMLElement} addFormRoot
 * @param {HTMLElement} tableHost
 */
async function fetchDetect(model, base_url, api_key) {
  const res = await fetch(`${API_BASE}/api/credentials/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, base_url, api_key }),
  });
  return res.json().catch(() => ({}));
}

function wireCredentialsAddForm(addFormRoot, tableHost) {
  const modelInput = addFormRoot.querySelector('#credentials-model');
  const baseUrlInput = addFormRoot.querySelector('#credentials-base-url');
  const apiKeyInput = addFormRoot.querySelector('#credentials-api-key');
  const suggestionsList = addFormRoot.querySelector('#credentials-model-suggestions');
  const chooseModelBtn = addFormRoot.querySelector('#credentials-choose-model-btn');

  let lastDetectKey = '';

  function resetForm() {
    lastDetectKey = '';
    if (suggestionsList) suggestionsList.innerHTML = '';
  }

  // Cosmetic only: populates the Model ID suggestion dropdown. Never sets what gets saved.
  async function runDetect() {
    const model = (modelInput?.value || '').trim();
    const base_url = (baseUrlInput?.value || '').trim();
    const api_key = (apiKeyInput?.value || '').trim();
    if (!base_url && !api_key && !model) return;
    const detectKey = JSON.stringify([model, base_url, api_key]);
    if (detectKey === lastDetectKey) return;
    lastDetectKey = detectKey;

    try {
      const data = await fetchDetect(model, base_url, api_key);
      if (lastDetectKey !== detectKey) return; // superseded by a newer probe
      if (suggestionsList) {
        suggestionsList.innerHTML = (data.models || [])
          .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`)
          .join('');
      }
    } catch (e) {
      // Suggestions are a nicety; silently skip on failure.
    }
  }

  modelInput?.addEventListener('blur', runDetect);
  baseUrlInput?.addEventListener('blur', runDetect);
  apiKeyInput?.addEventListener('blur', runDetect);

  function onChooseModelClick() {
    // Browsing doesn't need a key yet: litellm.model_cost is a static, offline catalog of
    // known model ids across providers. The key is still required at Add time, same as today.
    openModelPicker({
      loadModels: loadLiteLlmCatalog,
      renderTitle: (m) => PROVIDER_LABELS[m.provider] || m.provider || m.id,
      renderMeta: defaultModelPickerMeta,
      onPick: (modelId, close) => {
        if (modelInput) modelInput.value = modelId;
        close();
      },
    });
  }

  chooseModelBtn?.addEventListener('click', onChooseModelClick);

  async function onAddCredentialSubmit() {
    const llm = (modelInput?.value || '').trim();
    const base_url = (baseUrlInput?.value || '').trim();
    const api_key = (apiKeyInput?.value || '').trim();
    if (!llm) {
      console.warn('Please enter a model ID');
      return;
    }
    if (!api_key) {
      console.warn('Please enter an API key');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: llm, base_url, api_key }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = typeof err.detail === 'string' ? err.detail : Array.isArray(err.detail) ? err.detail.map((d) => d?.msg || String(d)).join(', ') : 'Add failed';
        showAlert(msg, { title: 'Add credential failed' });
        return;
      }
      const saved = await res.json().catch(() => ({}));
      apiKeyInput.value = '';
      if (modelInput) modelInput.value = '';
      if (baseUrlInput) baseUrlInput.value = '';
      resetForm();
      await loadAndRenderCredentials(tableHost);
      tableHost._onCredentialsChange?.();
      if (saved.id) runCredentialCheck(tableHost, saved.id); // background; result shows in the table's Status column
    } catch (e) {
      const msg = (e && e.message) || String(e);
      showAlert(msg, { title: 'Add credential failed' });
      console.error('Add credential:', e);
    }
  }

  return { submit: onAddCredentialSubmit };
}

function wireCredentialsAddTabs(addFormRoot, { onSwitchTo } = {}) {
  const select = addFormRoot.querySelector('#credentials-add-method-select');
  if (!select) return;
  const panels = addFormRoot.querySelectorAll('.credentials-add-tab-panel[data-panel]');
  select.addEventListener('change', () => {
    const name = select.value;
    panels.forEach((p) => p.classList.toggle('credentials-add-tab-panel--active', p.dataset.panel === name));
    onSwitchTo?.(name);
  });
}

const OPENROUTER_POLL_MS = 1500;
const OPENROUTER_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function wireOpenRouterConnect(addFormRoot, tableHost) {
  const connectBtn = addFormRoot.querySelector('#credentials-openrouter-connect-btn');
  const statusEl = addFormRoot.querySelector('#credentials-openrouter-status');
  const modelField = addFormRoot.querySelector('#credentials-openrouter-model-field');
  const modelInput = addFormRoot.querySelector('#credentials-openrouter-model');
  const chooseModelBtn = addFormRoot.querySelector('#credentials-openrouter-choose-model-btn');
  if (!connectBtn) return;
  let pollTimer = null;
  let connectedCredentialId = null;

  // Reconnecting isn't required just to add another model: if an OpenRouter credential
  // already exists and its key still actually works, reveal the Model ID field for it right
  // away. Re-run whenever the dropdown switches back to this tab, not just once at modal-open.
  // A cached last_check_ok isn't good enough here -- it can go stale as soon as the key is
  // revoked/expires on OpenRouter's side, so this does a real (small) test call, most-recently
  // -added credential first, stopping at the first one that actually still works.
  async function checkExistingConnection() {
    if (pollTimer) return; // a connect is actively in progress; don't stomp its status text
    connectedCredentialId = null;
    if (modelField) modelField.hidden = true;
    let list;
    try {
      list = await fetchCredentialsStrict();
    } catch (e) {
      statusEl.textContent = '';
      return;
    }
    const openRouterCreds = list.filter((c) => c.provider === 'openrouter');
    if (openRouterCreds.length === 0) {
      statusEl.textContent = '';
      return;
    }
    statusEl.textContent = 'Checking OpenRouter connection…';
    for (const cred of openRouterCreds.slice().reverse()) { // most recently added first
      const ok = await runCredentialCheck(tableHost, cred.id);
      if (ok) {
        connectedCredentialId = cred.id;
        if (modelField) modelField.hidden = false;
        statusEl.textContent = 'Connected to OpenRouter.';
        return;
      }
    }
    statusEl.textContent = 'No working OpenRouter connection found — click Connect.';
  }
  checkExistingConnection();

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    connectBtn.disabled = false;
  }

  async function onConnectClick() {
    statusEl.textContent = '';
    connectBtn.disabled = true;
    if (modelField) modelField.hidden = true;
    connectedCredentialId = null;
    let started;
    try {
      const res = await fetch(`${API_BASE}/api/credentials/openrouter/start`, { method: 'POST' });
      started = await res.json().catch(() => ({}));
      if (!res.ok || !started.auth_url || !started.state) throw new Error('Could not start OpenRouter login.');
    } catch (e) {
      statusEl.textContent = (e && e.message) || 'Could not start OpenRouter login.';
      connectBtn.disabled = false;
      return;
    }
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(started.auth_url);
    else window.open(started.auth_url, '_blank', 'noopener');
    statusEl.textContent = 'Waiting for approval in your browser…';
    const deadline = Date.now() + OPENROUTER_POLL_TIMEOUT_MS;
    pollTimer = setInterval(async () => {
      if (Date.now() > deadline) {
        stopPolling();
        statusEl.textContent = 'Timed out waiting for OpenRouter. Please try again.';
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/credentials/openrouter/status/${started.state}`);
        const data = await res.json().catch(() => ({}));
        if (data.status === 'done') {
          stopPolling();
          statusEl.textContent = 'Connected.';
          connectedCredentialId = data.credential_id || null;
          if (modelField) modelField.hidden = !connectedCredentialId;
          await loadAndRenderCredentials(tableHost);
          tableHost._onCredentialsChange?.();
          if (data.credential_id) runCredentialCheck(tableHost, data.credential_id);
        } else if (data.status === 'error' || data.status === 'not_found') {
          stopPolling();
          statusEl.textContent = data.error || 'Could not complete the OpenRouter connection.';
        }
      } catch (e) {
        // Transient network hiccup while polling; keep trying until the timeout.
      }
    }, OPENROUTER_POLL_MS);
  }

  function onChooseModelClick() {
    // OpenRouter's own live catalog (no key needed to browse it, same as before) --
    // picking here only fills the Model ID field, same as the LiteLLM picker does.
    openModelPicker({
      loadModels: loadOpenRouterCatalog,
      onPick: (modelId, close) => {
        if (modelInput) modelInput.value = modelId;
        close();
      },
    });
  }

  async function submitOpenRouterModel() {
    if (!connectedCredentialId) {
      showAlert('Connect to OpenRouter first.', { title: 'Add credential failed' });
      return;
    }
    const model = (modelInput?.value || '').trim();
    if (!model) {
      showAlert('Choose or type a model ID first.', { title: 'Add credential failed' });
      return;
    }
    try {
      const keyRes = await fetch(`${API_BASE}/api/credentials/${connectedCredentialId}`);
      if (!keyRes.ok) throw new Error('Could not read the connected OpenRouter key.');
      const apiKey = (await keyRes.json()).api_key;
      if (!apiKey) throw new Error('Could not read the connected OpenRouter key.');
      const res = await fetch(`${API_BASE}/api/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, api_key: apiKey, provider: 'openrouter' }),
      });
      if (!res.ok) throw new Error('Could not add that model.');
      const saved = await res.json().catch(() => ({}));
      if (modelInput) modelInput.value = '';
      await loadAndRenderCredentials(tableHost);
      tableHost._onCredentialsChange?.();
      if (saved.id) runCredentialCheck(tableHost, saved.id);
    } catch (e) {
      showAlert((e && e.message) || 'Could not add that model.', { title: 'Add credential failed' });
    }
  }

  connectBtn.addEventListener('click', onConnectClick);
  chooseModelBtn?.addEventListener('click', onChooseModelClick);

  return { checkExistingConnection, submit: submitOpenRouterModel };
}

/* ——— Modal ——— */

export function openSettingsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'model-settings-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--defaults modal-panel--model-settings-combined">
      <div class="modal-header">
        <h2 id="model-settings-title" class="modal-title">LLM settings</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--defaults modal-body--model-settings-combined">
        <div class="model-settings-preview-wrap model-settings-preview-wrap--full">
          <div class="model-settings-preview-body">
            <div class="model-settings-columns">
              <h3 id="model-settings-col-credentials-title" class="model-settings-col-heading model-settings-col-heading--credentials">Credentials</h3>
              <h3 id="model-settings-col-settings-title" class="model-settings-col-heading model-settings-col-heading--settings">Settings</h3>
              <aside class="model-settings-col model-settings-col-left" aria-labelledby="model-settings-col-credentials-title">
                <div id="model-settings-credentials-root"></div>
              </aside>
              <div class="model-settings-col model-settings-col-right" aria-labelledby="model-settings-col-settings-title">
                <div class="model-settings-main">
                  <div class="model-settings-tab-row">
                    <div class="review-detail-view-switch model-settings-view-switch" role="tablist" aria-label="Settings options">
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active" role="tab" aria-selected="true" aria-controls="settings-panel-credentials" id="settings-tab-credentials" data-tab="credentials">New credential</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-run" id="settings-tab-run" data-tab="run">Run defaults</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-review" id="settings-tab-review" data-tab="review">Review defaults</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-agent" id="settings-tab-agent" data-tab="agent">Agent defaults</button>
                    </div>
                  </div>
                  <div class="review-detail-tab-panels model-settings-tab-panels">
                    <div class="review-detail-tab-panel review-detail-tab-panel--active" id="settings-panel-credentials" role="tabpanel" aria-labelledby="settings-tab-credentials" data-panel="credentials">
                      <div class="defaults-page-scroll settings-credentials-tab-body">
                        <div id="model-settings-credentials-add" class="model-settings-credentials-add">
                          <div class="credentials-add-method-row">
                            <label class="dataset-meta-label" for="credentials-add-method-select">Add credential</label>
                            <select id="credentials-add-method-select" class="dataset-meta-input credentials-add-method-select" aria-label="Add credential method">
                              <option value="litellm" selected>Via LiteLLM</option>
                              <option value="openrouter">Via OpenRouter</option>
                            </select>
                          </div>
                          <div class="credentials-add-tab-panels">
                            <div class="credentials-add-tab-panel credentials-add-tab-panel--active" id="credentials-add-panel-litellm" data-panel="litellm">
                              <div class="credentials-add-row">
                                <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                                  <label class="dataset-meta-label" for="credentials-model">Model ID</label>
                                  <div class="credentials-model-input-row">
                                    <input type="text" id="credentials-model" class="dataset-meta-input" placeholder="e.g. gpt-5, anthropic/claude-sonnet-4-6" autocomplete="off" aria-label="Model ID" list="credentials-model-suggestions" />
                                    <button type="button" class="btn btn-secondary" id="credentials-choose-model-btn">Choose model</button>
                                  </div>
                                  <datalist id="credentials-model-suggestions"></datalist>
                                </div>
                                <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                                  <label class="dataset-meta-label" for="credentials-api-key">API key</label>
                                  <input type="text" id="credentials-api-key" class="dataset-meta-input credentials-api-key-input" placeholder="Paste your API key" autocomplete="off" />
                                </div>
                                <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                                  <label class="dataset-meta-label" for="credentials-base-url">Base URL (optional)</label>
                                  <input type="text" id="credentials-base-url" class="dataset-meta-input" placeholder="e.g. http://localhost:11434/v1" autocomplete="off" aria-label="Base URL" />
                                </div>
                              </div>
                            </div>
                            <div class="credentials-add-tab-panel" id="credentials-add-panel-openrouter" data-panel="openrouter">
                              <div class="credentials-add-row">
                                <div class="credentials-add-field credentials-add-field--full-row">
                                  <label class="dataset-meta-label" for="credentials-openrouter-connect-btn">OpenRouter account</label>
                                  <div class="credentials-openrouter-connect-row">
                                    <button type="button" class="btn btn-secondary" id="credentials-openrouter-connect-btn">Connect</button>
                                    <p class="credentials-add-openrouter-status" id="credentials-openrouter-status" aria-live="polite"></p>
                                  </div>
                                </div>
                                <div class="credentials-add-field credentials-add-field--full-row" id="credentials-openrouter-model-field" hidden>
                                  <label class="dataset-meta-label" for="credentials-openrouter-model">Model ID</label>
                                  <div class="credentials-model-input-row">
                                    <input type="text" id="credentials-openrouter-model" class="dataset-meta-input" placeholder="e.g. anthropic/claude-sonnet-4.6" autocomplete="off" aria-label="Model ID" />
                                    <button type="button" class="btn btn-secondary" id="credentials-openrouter-choose-model-btn">Choose model</button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="review-detail-tab-panel" id="settings-panel-run" role="tabpanel" aria-labelledby="settings-tab-run" data-panel="run">
                      <div class="defaults-page-scroll">
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-run-credential">Default model</label>
                              <select id="settings-default-run-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Run">
                                <option value="">${selectPlaceholderLabel('None (select each time)')}</option>
                              </select>
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-run-max-tokens">Max tokens (256–131072)</label>
                              <input type="number" id="settings-run-max-tokens" class="dataset-meta-input" min="256" max="131072" value="8192" aria-label="Run max tokens" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-run-max-retries">Max retries on error (0–5)</label>
                              <input type="number" id="settings-run-max-retries" class="dataset-meta-input" min="0" max="5" value="2" aria-label="Run max retries" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-run-concurrency">Concurrency (1–10)</label>
                              <input type="number" id="settings-run-concurrency" class="dataset-meta-input" min="1" max="10" value="4" aria-label="Run concurrency" />
                            </div>
                          </div>
                      </div>
                    </div>
                    <div class="review-detail-tab-panel" id="settings-panel-review" role="tabpanel" aria-labelledby="settings-tab-review" data-panel="review">
                      <div class="defaults-page-scroll">
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-review-credential">Default model</label>
                              <select id="settings-default-review-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Review">
                                <option value="">${selectPlaceholderLabel('None (select each time)')}</option>
                              </select>
                            </div>
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-review-method">Default review method</label>
                              <select id="settings-default-review-method" class="credentials-select dataset-meta-input" aria-label="Default review method"></select>
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="gepa" hidden>
                              <label class="dataset-meta-label" for="settings-gepa-max-iterations">GEPA max iterations (4–200)</label>
                              <input type="number" id="settings-gepa-max-iterations" class="dataset-meta-input" min="4" max="200" value="15" aria-label="GEPA reflective-evolution max iterations" title="Each iteration runs the task model against every targeted input, then one reflection call — cost scales with iterations × inputs." />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="miprov2" hidden>
                              <label class="dataset-meta-label" for="settings-miprov2-num-trials">MIPROv2 trials (4–200)</label>
                              <input type="number" id="settings-miprov2-num-trials" class="dataset-meta-input" min="4" max="200" value="10" aria-label="MIPROv2 optimization trials" title="Each trial evaluates one instructions+demos combination against every targeted input — cost scales with trials × inputs." />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="bootstrap_fewshot" hidden>
                              <label class="dataset-meta-label" for="settings-bootstrap-fewshot-num-candidates">BootstrapFewShot candidates (2–100)</label>
                              <input type="number" id="settings-bootstrap-fewshot-num-candidates" class="dataset-meta-input" min="2" max="100" value="10" aria-label="BootstrapFewShotWithRandomSearch candidate demo sets" title="Each candidate bootstraps and evaluates a different demo set against every targeted input — cost scales with candidates × inputs." />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="textgrad" hidden>
                              <label class="dataset-meta-label" for="settings-textgrad-num-steps">TextGrad steps (2–50)</label>
                              <input type="number" id="settings-textgrad-num-steps" class="dataset-meta-input" min="2" max="50" value="6" aria-label="TextGrad textual-gradient-descent steps" title="Each step runs a forward pass, a textual-gradient backward pass, and an optimizer rewrite call against every targeted input — cost scales with steps × inputs × ~3." />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="copro" hidden>
                              <label class="dataset-meta-label" for="settings-copro-breadth">COPRO breadth (2–30)</label>
                              <input type="number" id="settings-copro-breadth" class="dataset-meta-input" min="2" max="30" value="6" aria-label="COPRO instruction variants per round" title="Each round proposes this many instruction variants and evaluates every one against every targeted input — cost scales with breadth × depth × inputs." />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="copro" hidden>
                              <label class="dataset-meta-label" for="settings-copro-depth">COPRO depth (1–10)</label>
                              <input type="number" id="settings-copro-depth" class="dataset-meta-input" min="1" max="10" value="3" aria-label="COPRO coordinate-ascent rounds" title="Coordinate-ascent rounds — each round refines the previous round's best instruction. Cost scales with breadth × depth × inputs." />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="simba" hidden>
                              <label class="dataset-meta-label" for="settings-simba-max-steps">SIMBA steps (2–40)</label>
                              <input type="number" id="settings-simba-max-steps" class="dataset-meta-input" min="2" max="40" value="8" aria-label="SIMBA mini-batch introspection steps" title="Each step samples a mini-batch, runs several stochastic rollouts, and has the model introspect on the results — cost scales with steps × mini-batch size × candidates." />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-tokens">Max tokens (256–131072)</label>
                              <input type="number" id="settings-review-max-tokens" class="dataset-meta-input" min="256" max="131072" value="32768" aria-label="Review max tokens" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-failed-rows">Max failed inputs per Review (1–200)</label>
                              <input type="number" id="settings-review-max-failed-rows" class="dataset-meta-input" min="1" max="200" value="30" aria-label="Max inputs with failures analyzed per Review" />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="issue_analysis_suggestions" hidden>
                              <label class="dataset-meta-label" for="settings-optimization-max-trials">Max trials per optimization run (4–200)</label>
                              <input type="number" id="settings-optimization-max-trials" class="dataset-meta-input" min="4" max="200" value="40" aria-label="Optimization max Thompson-sampling trials" title="Only used by the built-in method's suggestion-card 'Optimize' pill (Thompson-sampling segment search) — no other review method reads this." />
                            </div>
                            <div class="defaults-field defaults-field--full" style="margin-top:0.5rem;">
                              <label class="dataset-meta-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                                <input type="checkbox" id="settings-debug-mode" aria-label="Debug mode" />
                                Debug mode
                              </label>
                            </div>
                          </div>
                      </div>
                    </div>
                    <div class="review-detail-tab-panel" id="settings-panel-agent" role="tabpanel" aria-labelledby="settings-tab-agent" data-panel="agent">
                      <div class="defaults-page-scroll">
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-agent-credential">Default model</label>
                              <select id="settings-default-agent-credential" class="credentials-select dataset-meta-input" aria-label="Default model for the Agent window">
                                <option value="">${selectPlaceholderLabel('None (select each time)')}</option>
                              </select>
                            </div>
                          </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="prompt-actions model-settings-footer">
                  <div id="model-settings-footer-save-restore" class="model-settings-footer__save-restore" hidden>
                    <button type="button" class="btn btn-secondary" id="settings-restore-defaults">Restore defaults</button>
                    <button type="button" class="btn btn-primary" id="settings-save">Save</button>
                  </div>
                  <button type="button" class="btn btn-primary" id="settings-footer-add">Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const runCredSelect = overlay.querySelector('#settings-default-run-credential');
  const reviewCredSelect = overlay.querySelector('#settings-default-review-credential');
  const agentCredSelect = overlay.querySelector('#settings-default-agent-credential');
  const reviewMethodDefaultSelect = overlay.querySelector('#settings-default-review-method');
  const methodSpecificSettingsBlocks = overlay.querySelectorAll('.settings-review-method-specific[data-method-settings]');
  const gepaMaxIterationsInp = overlay.querySelector('#settings-gepa-max-iterations');
  const miprov2NumTrialsInp = overlay.querySelector('#settings-miprov2-num-trials');
  const bootstrapFewshotNumCandidatesInp = overlay.querySelector('#settings-bootstrap-fewshot-num-candidates');
  const textgradNumStepsInp = overlay.querySelector('#settings-textgrad-num-steps');
  const coproBreadthInp = overlay.querySelector('#settings-copro-breadth');
  const coproDepthInp = overlay.querySelector('#settings-copro-depth');
  const simbaMaxStepsInp = overlay.querySelector('#settings-simba-max-steps');
  const runMaxTokensInp = overlay.querySelector('#settings-run-max-tokens');
  const reviewMaxTokensInp = overlay.querySelector('#settings-review-max-tokens');
  const reviewMaxFailedRowsInp = overlay.querySelector('#settings-review-max-failed-rows');
  const runMaxRetriesInp = overlay.querySelector('#settings-run-max-retries');
  const runConcurrencyInp = overlay.querySelector('#settings-run-concurrency');
  const optimizationMaxTrialsInp = overlay.querySelector('#settings-optimization-max-trials');
  const debugModeChk = overlay.querySelector('#settings-debug-mode');
  const tabBar = overlay.querySelector('.model-settings-view-switch');
  const tabs = tabBar ? tabBar.querySelectorAll('.review-detail-tab[data-tab]') : [];
  const panels = overlay.querySelectorAll('.model-settings-tab-panels .review-detail-tab-panel[data-panel]');
  const footerSaveRestore = overlay.querySelector('#model-settings-footer-save-restore');
  const footerAdd = overlay.querySelector('#settings-footer-add');

  function activateSettingsTab(name) {
    const n = name === 'run' || name === 'review' || name === 'agent' || name === 'credentials' ? name : 'credentials';
    tabs.forEach((btn) => {
      const on = btn.dataset.tab === n;
      btn.classList.toggle('review-detail-tab--active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach((p) => {
      p.classList.toggle('review-detail-tab-panel--active', p.dataset.panel === n);
    });
    const isCredentials = n === 'credentials';
    if (footerSaveRestore) footerSaveRestore.hidden = isCredentials;
    if (footerAdd) footerAdd.hidden = !isCredentials;
  }

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => activateSettingsTab(btn.dataset.tab));
  });

  async function loadCredentials() {
    try {
      const res = await fetch(`${API_BASE}/api/credentials`);
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.error('Load credentials:', e);
      return [];
    }
  }

  async function loadSettings() {
    try {
      const res = await fetch(`${API_BASE}/api/settings`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.error('Load settings:', e);
      return null;
    }
  }

  async function loadReviewMethodOptions() {
    try {
      const res = await fetch(`${API_BASE}/api/review/methods`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.methods) ? data.methods : [];
    } catch (e) {
      console.error('Load review methods:', e);
      return [];
    }
  }

  /**
   * Each review method may own a block of method-specific settings (e.g. GEPA's max-iterations field);
   * only the block matching the currently-selected "Default review method" is shown. A method used
   * per-node without being the global default still shares this one global setting value — there's no
   * per-node override for it — so switching the dropdown away from a method hides, but does not disable,
   * whatever that method's setting was last saved as.
   */
  function updateMethodSpecificSettingsVisibility() {
    const selected = reviewMethodDefaultSelect?.value || '';
    methodSpecificSettingsBlocks.forEach((el) => {
      el.hidden = el.dataset.methodSettings !== selected;
    });
  }

  function populateReviewMethodSelect(methods) {
    if (!reviewMethodDefaultSelect) return;
    const wrap = reviewMethodDefaultSelect.closest('.defaults-field');
    /* Nothing to choose between — don't show a picker with one option (matches the per-node picker in
     * scoreDetailModal.js, which hides the same way when the registry has ≤1 method). */
    if (wrap) wrap.hidden = methods.length <= 1;
    /* No blank "registry default" placeholder — the first method (the registry's own default, listed
     * first by backend/review_methods.py) is always a real, visible selection. */
    reviewMethodDefaultSelect.innerHTML = methods
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`)
      .join('');
    updateMethodSpecificSettingsVisibility();
  }

  reviewMethodDefaultSelect?.addEventListener('change', updateMethodSpecificSettingsVisibility);

  function populateCredentialSelects(credentials) {
    const optHtml = credentials.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.model || c.llm || c.id)}</option>`
    ).join('');
    const optNone = `<option value="">${selectPlaceholderLabel('None (select each time)')}</option>`;
    runCredSelect.innerHTML = optNone + optHtml;
    reviewCredSelect.innerHTML = optNone + optHtml;
    if (agentCredSelect) agentCredSelect.innerHTML = optNone + optHtml;
  }

  function applySettings(settings) {
    if (!settings) return;
    runCredSelect.value = settings.default_run_credential_id || '';
    reviewCredSelect.value = settings.default_review_credential_id || '';
    if (agentCredSelect) agentCredSelect.value = settings.default_agent_credential_id || '';
    if (reviewMethodDefaultSelect) {
      if (settings.default_review_method) {
        reviewMethodDefaultSelect.value = settings.default_review_method;
      } else if (reviewMethodDefaultSelect.options.length > 0) {
        /* No explicit default — show the registry's own default (first option) rather than leaving
         * whatever was previously selected, so "Restore defaults" visibly resets this field too. */
        reviewMethodDefaultSelect.selectedIndex = 0;
      }
    }
    if (gepaMaxIterationsInp) {
      gepaMaxIterationsInp.value = String(settings.gepa_max_iterations ?? MODEL_SETTINGS_DEFAULTS.gepa_max_iterations);
    }
    if (miprov2NumTrialsInp) {
      miprov2NumTrialsInp.value = String(settings.miprov2_num_trials ?? MODEL_SETTINGS_DEFAULTS.miprov2_num_trials);
    }
    if (bootstrapFewshotNumCandidatesInp) {
      bootstrapFewshotNumCandidatesInp.value = String(settings.bootstrap_fewshot_num_candidates ?? MODEL_SETTINGS_DEFAULTS.bootstrap_fewshot_num_candidates);
    }
    if (textgradNumStepsInp) {
      textgradNumStepsInp.value = String(settings.textgrad_num_steps ?? MODEL_SETTINGS_DEFAULTS.textgrad_num_steps);
    }
    if (coproBreadthInp) {
      coproBreadthInp.value = String(settings.copro_breadth ?? MODEL_SETTINGS_DEFAULTS.copro_breadth);
    }
    if (coproDepthInp) {
      coproDepthInp.value = String(settings.copro_depth ?? MODEL_SETTINGS_DEFAULTS.copro_depth);
    }
    if (simbaMaxStepsInp) {
      simbaMaxStepsInp.value = String(settings.simba_max_steps ?? MODEL_SETTINGS_DEFAULTS.simba_max_steps);
    }
    updateMethodSpecificSettingsVisibility();
    runMaxTokensInp.value = String(settings.run_max_tokens ?? MODEL_SETTINGS_DEFAULTS.run_max_tokens);
    reviewMaxTokensInp.value = String(settings.review_max_tokens ?? MODEL_SETTINGS_DEFAULTS.review_max_tokens);
    reviewMaxFailedRowsInp.value = String(settings.review_max_failed_rows ?? MODEL_SETTINGS_DEFAULTS.review_max_failed_rows);
    runMaxRetriesInp.value = String(settings.run_max_retries ?? MODEL_SETTINGS_DEFAULTS.run_max_retries);
    runConcurrencyInp.value = String(settings.run_concurrency ?? MODEL_SETTINGS_DEFAULTS.run_concurrency);
    optimizationMaxTrialsInp.value = String(settings.optimization_max_trials ?? MODEL_SETTINGS_DEFAULTS.optimization_max_trials);
    debugModeChk.checked = settings.debug_mode ?? MODEL_SETTINGS_DEFAULTS.debug_mode;
  }

  async function init() {
    const credRoot = overlay.querySelector('#model-settings-credentials-root');
    const addRoot = overlay.querySelector('#model-settings-credentials-add');
    await mountCredentialsTableHost(credRoot, {
      onCredentialsChange: async () => {
        const ids = {
          run: (runCredSelect.value || '').trim(),
          review: (reviewCredSelect.value || '').trim(),
          agent: (agentCredSelect?.value || '').trim(),
        };
        const credentials = await loadCredentials();
        populateCredentialSelects(credentials);
        runCredSelect.value = ids.run;
        reviewCredSelect.value = ids.review;
        if (agentCredSelect) agentCredSelect.value = ids.agent;
      },
    });
    const liteLlmAdd = wireCredentialsAddForm(addRoot, credRoot);
    const openRouterConnect = wireOpenRouterConnect(addRoot, credRoot);
    const addMethodSelect = addRoot.querySelector('#credentials-add-method-select');
    wireCredentialsAddTabs(addRoot, {
      onSwitchTo: (name) => { if (name === 'openrouter') openRouterConnect?.checkExistingConnection(); },
    });
    footerAdd?.addEventListener('click', () => {
      if (addMethodSelect?.value === 'openrouter') openRouterConnect?.submit();
      else liteLlmAdd?.submit();
    });
    const [credentials, settings, reviewMethods] = await Promise.all([
      loadCredentials(),
      loadSettings(),
      loadReviewMethodOptions(),
    ]);
    populateCredentialSelects(credentials);
    populateReviewMethodSelect(reviewMethods);
    applySettings(settings || MODEL_SETTINGS_DEFAULTS);
  }

  function getPatchFromForm() {
    const runMaxTokens = Math.min(131072, Math.max(256, parseInt(runMaxTokensInp.value, 10) || 8192));
    const reviewMaxTokens = Math.min(131072, Math.max(256, parseInt(reviewMaxTokensInp.value, 10) || 32768));
    const reviewMaxFailedRows = Math.min(200, Math.max(1, parseInt(reviewMaxFailedRowsInp.value, 10) || 30));
    const runMaxRetriesParsed = parseInt(runMaxRetriesInp.value, 10);
    const runMaxRetries = Math.min(
      5,
      Math.max(0, Number.isNaN(runMaxRetriesParsed) ? MODEL_SETTINGS_DEFAULTS.run_max_retries : runMaxRetriesParsed),
    );
    const runConcurrencyParsed = parseInt(runConcurrencyInp.value, 10);
    const runConcurrency = Math.min(
      10,
      Math.max(1, Number.isNaN(runConcurrencyParsed) ? MODEL_SETTINGS_DEFAULTS.run_concurrency : runConcurrencyParsed),
    );
    const optimizationMaxTrialsParsed = parseInt(optimizationMaxTrialsInp.value, 10);
    const optimizationMaxTrials = Math.min(200, Math.max(4, Number.isNaN(optimizationMaxTrialsParsed) ? MODEL_SETTINGS_DEFAULTS.optimization_max_trials : optimizationMaxTrialsParsed));
    const gepaMaxIterationsParsed = parseInt(gepaMaxIterationsInp?.value, 10);
    const gepaMaxIterations = Math.min(200, Math.max(4, Number.isNaN(gepaMaxIterationsParsed) ? MODEL_SETTINGS_DEFAULTS.gepa_max_iterations : gepaMaxIterationsParsed));
    const miprov2NumTrialsParsed = parseInt(miprov2NumTrialsInp?.value, 10);
    const miprov2NumTrials = Math.min(200, Math.max(4, Number.isNaN(miprov2NumTrialsParsed) ? MODEL_SETTINGS_DEFAULTS.miprov2_num_trials : miprov2NumTrialsParsed));
    const bootstrapFewshotNumCandidatesParsed = parseInt(bootstrapFewshotNumCandidatesInp?.value, 10);
    const bootstrapFewshotNumCandidates = Math.min(100, Math.max(2, Number.isNaN(bootstrapFewshotNumCandidatesParsed) ? MODEL_SETTINGS_DEFAULTS.bootstrap_fewshot_num_candidates : bootstrapFewshotNumCandidatesParsed));
    const textgradNumStepsParsed = parseInt(textgradNumStepsInp?.value, 10);
    const textgradNumSteps = Math.min(50, Math.max(2, Number.isNaN(textgradNumStepsParsed) ? MODEL_SETTINGS_DEFAULTS.textgrad_num_steps : textgradNumStepsParsed));
    const coproBreadthParsed = parseInt(coproBreadthInp?.value, 10);
    const coproBreadth = Math.min(30, Math.max(2, Number.isNaN(coproBreadthParsed) ? MODEL_SETTINGS_DEFAULTS.copro_breadth : coproBreadthParsed));
    const coproDepthParsed = parseInt(coproDepthInp?.value, 10);
    const coproDepth = Math.min(10, Math.max(1, Number.isNaN(coproDepthParsed) ? MODEL_SETTINGS_DEFAULTS.copro_depth : coproDepthParsed));
    const simbaMaxStepsParsed = parseInt(simbaMaxStepsInp?.value, 10);
    const simbaMaxSteps = Math.min(40, Math.max(2, Number.isNaN(simbaMaxStepsParsed) ? MODEL_SETTINGS_DEFAULTS.simba_max_steps : simbaMaxStepsParsed));
    return {
      default_run_credential_id: (runCredSelect.value || '').trim() || '',
      default_review_credential_id: (reviewCredSelect.value || '').trim() || '',
      default_agent_credential_id: (agentCredSelect?.value || '').trim() || '',
      default_review_method: (reviewMethodDefaultSelect?.value || '').trim() || '',
      gepa_max_iterations: gepaMaxIterations,
      miprov2_num_trials: miprov2NumTrials,
      bootstrap_fewshot_num_candidates: bootstrapFewshotNumCandidates,
      textgrad_num_steps: textgradNumSteps,
      copro_breadth: coproBreadth,
      copro_depth: coproDepth,
      simba_max_steps: simbaMaxSteps,
      run_max_tokens: runMaxTokens,
      review_max_tokens: reviewMaxTokens,
      review_max_failed_rows: reviewMaxFailedRows,
      run_max_retries: runMaxRetries,
      run_concurrency: runConcurrency,
      optimization_max_trials: optimizationMaxTrials,
      debug_mode: debugModeChk.checked,
    };
  }

  async function doSave() {
    const patch = getPatchFromForm();
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || res.statusText || 'Save failed');
      }
      return true;
    } catch (e) {
      showAlert(e.message || 'Failed to save settings.', { title: 'Error' });
      return false;
    }
  }

  function closeModal() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.querySelector('#settings-restore-defaults')?.addEventListener('click', () => {
    applySettings(MODEL_SETTINGS_DEFAULTS);
  });
  overlay.querySelector('#settings-save')?.addEventListener('click', async () => {
    await doSave();
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  init().catch((e) => console.error('Model settings init:', e));
}
