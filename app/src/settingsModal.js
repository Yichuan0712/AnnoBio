/**
 * Model settings modal: credentials table (left, always visible); Runner / Reviewer / add-credentials (right tabs).
 * APIs: /api/credentials, /api/settings.
 */

import { showAlert, showConfirm } from './alertModal.js';
import { selectPlaceholderLabel } from './displayTextNormalize.js';
import { BACKEND_API_BASE, waitForBackend } from './backendConfig.js';
import { fetchAgentContext } from './agent/api/agentTurnClient.js';
import { mountPillSelect } from './pillSelect.js';
import { attachModelIdAutocomplete } from './modelIdAutocomplete.js';
import { PER_MODEL_FIELDS, bindModelFields, keepKnownModels } from './perModelSettings.js';
import { paramLabel, paramValue, withRunParams } from './runParams.js';

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
  /** The Agent model's context window in tokens; 0 = auto (the model registries). */
  agent_context_tokens: 0,
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
  if (c.builtin) return '<span class="credential-source-badge">Included</span>';
  const isOpenRouter = c.provider === 'openrouter';
  const label = isOpenRouter ? 'OpenRouter' : 'LiteLLM';
  const kind = isOpenRouter ? 'openrouter' : 'litellm';
  return `<span class="credential-source-badge credential-source-badge--${kind}">${label}</span>`;
}

const STATUS_TEXT = { ok: '✓ Verified', error: '✗ Failed', pending: 'Testing…', none: 'Test' };
const retestHint = (message) => `${String(message).replace(/[.\s]+$/, '')}. Click to test again.`;

/** The Status cell: the last test's result, which is also the control that tests again. */
function credentialStatusButton(c) {
  if (c.builtin) return '<span class="credentials-managed-label">Managed</span>';
  const kind = c.last_check_ok === true ? 'ok' : c.last_check_ok === false ? 'error' : 'none';
  const title = kind === 'ok' ? retestHint(`Verified: ${PROVIDER_LABELS[c.provider] || c.provider || 'provider'}`)
    : kind === 'error' ? retestHint(c.last_check_error || 'Verification failed')
      : 'Not tested yet. Click to test.';
  return `<button type="button" class="credentials-status-btn credentials-status-btn--${kind}" data-status-id="${c.id}" title="${escapeHtml(title)}">${STATUS_TEXT[kind]}</button>`;
}

// Whose servers a LiteLLM credential without a Base URL calls.
const DEFAULT_ENDPOINT_LABELS = {
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', deepseek: 'DeepSeek', bedrock: 'AWS Bedrock',
};

/** The API Base cell: AnnoBio's model, OpenRouter, a provider's default endpoint, or a custom URL. */
function credentialEndpointCell(c) {
  if (c.builtin) return 'Provided by AnnoBio';
  if (c.provider === 'openrouter') return 'openrouter.ai';
  const url = (c.base_url || '').trim();
  if (!url) {
    const owner = DEFAULT_ENDPOINT_LABELS[c.provider];
    return `<span class="credentials-endpoint-default">${owner ? `${escapeHtml(owner)} default` : 'Provider default'}</span>`;
  }
  return `<span title="${escapeHtml(url)}">${escapeHtml(url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''))}</span>`;
}

const TRASH_ICON ='<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5"/></svg>';

// The web app never shows stored API keys, so its table has no API key column.
const showKeyColumn = () => Boolean(window.electronAPI);

function credentialsMessageRow(text) {
  return `<tr class="credentials-table-empty"><td colspan="${showKeyColumn() ? 5 : 4}">${text}</td></tr>`;
}

function renderCredentialsTable(scope, list) {
  const tbody = getCredTbody(scope);
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = credentialsMessageRow('No credentials added yet.');
    return;
  }
  const maskedPlaceholder = '••••••••';
  const keyCell = (c) => (showKeyColumn() ? `
      <td class="cred-col-key ${c.builtin ? 'credentials-managed-cell' : 'credentials-key-cell'}">
        ${c.builtin ? '<span>Included</span>' : `<code class="credentials-key-value">${maskedPlaceholder}</code>`}
      </td>` : '');
  tbody.innerHTML = list.map((c) => `
    <tr data-credential-id="${c.id}">
      <td class="cred-col-model">${escapeHtml(credentialModelLabel(c))} ${credentialSourceBadge(c)}</td>
      <td class="cred-col-base credentials-provider-cell">${credentialEndpointCell(c)}</td>${keyCell(c)}
      <td class="cred-col-status">${credentialStatusButton(c)}</td>
      <td class="cred-col-delete">${c.builtin ? '' : `<button type="button" class="credentials-delete-btn" data-id="${c.id}" aria-label="Delete ${escapeHtml(credentialModelLabel(c))}" title="Delete">${TRASH_ICON}</button>`}</td>
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
    let list;
    try {
      list = await fetchCredentialsStrict();
    } catch (error) {
      // A network error right after launch usually means the backend is still starting.
      if (!(error instanceof TypeError)) throw error;
      const tbody = getCredTbody(scope);
      if (tbody) tbody.innerHTML = credentialsMessageRow('Waiting for the backend to start...');
      if (!(await waitForBackend())) throw error;
      list = await fetchCredentialsStrict();
    }
    renderCredentialsTable(scope, list);
    bindCredKeyCellClick(scope);
    bindCredTestButtons(scope);
    bindCredDeleteButtons(scope);
  } catch (e) {
    console.error('Load credentials:', e);
    const tbody = getCredTbody(scope);
    if (tbody) tbody.innerHTML = credentialsMessageRow('Unable to load (is the backend running?).');
  }
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

function setCredentialStatus(scope, id, { title, kind }) {
  const btn = scope.querySelector(`[data-status-id="${id}"]`);
  if (!btn) return;
  btn.textContent = STATUS_TEXT[kind];
  btn.title = title || '';
  btn.className = `credentials-status-btn credentials-status-btn--${kind}`;
  btn.disabled = kind === 'pending';
}

/**
 * The one real check: sends a minimal chat completion under candidate provider
 * interpretations (see backend verify_credential) and, if one succeeds, corrects the
 * credential's stored provider. Used by both the table's Status control and the
 * fire-and-forget check that runs right after Add -- same endpoint, same result rendering
 * (Verified or Failed in the Status column).
 */
async function runCredentialCheck(scope, id) {
  setCredentialStatus(scope, id, { title: 'Testing this credential…', kind: 'pending' });
  try {
    const res = await fetch(`${API_BASE}/api/credentials/${id}/test`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const label = PROVIDER_LABELS[data.provider] || data.provider || 'provider';
      setCredentialStatus(scope, id, { title: retestHint(`Verified: ${label}`), kind: 'ok' });
      return true;
    } else {
      const msg = typeof data.detail === 'string' ? data.detail : (data.error || 'Failed');
      setCredentialStatus(scope, id, { title: retestHint(msg), kind: 'error' });
      return false;
    }
  } catch (e) {
    setCredentialStatus(scope, id, { title: retestHint((e && e.message) || 'Network error'), kind: 'error' });
    return false;
  }
}

function bindCredTestButtons(scope) {
  scope.querySelectorAll('.credentials-status-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  scope.querySelectorAll('.credentials-status-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-status-id');
      // runCredentialCheck disables the control while the test runs.
      if (id) runCredentialCheck(scope, id);
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

/** "$3.00/M in / $15.00/M out", or '' when the catalog has no prices for the model. */
function formatModelPrices(m) {
  return (m.prompt_price != null || m.completion_price != null)
    ? `${formatModelPrice(m.prompt_price)} in / ${formatModelPrice(m.completion_price)} out`
    : '';
}

/** The detail line under a suggested model id: who serves it, its prices and what it can read. */
function describeSuggestedModel(m, source) {
  return [source, formatModelPrices(m), m.vision ? 'images' : '', m.pdf ? 'PDF' : ''].filter(Boolean).join(' · ');
}

function bindCredDeleteButtons(scope) {
  scope.querySelectorAll('.credentials-delete-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  scope.querySelectorAll('.credentials-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      // Found before the table is drawn again, which takes the button out of the page.
      const panel = btn.closest('.credentials-panel-host');
      const ok = await showConfirm('Delete this credential?', { title: 'Delete credential', confirmText: 'Delete' });
      if (!ok) return;
      try {
        const res = await fetch(`${API_BASE}/api/credentials/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadAndRenderCredentials(scope);
        panel?._onCredentialsChange?.();
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
          <table class="credentials-table${showKeyColumn() ? '' : ' credentials-table--no-key'}" aria-label="Model credentials">
            <thead>
              <tr>
                <th class="cred-col-model">Model</th>
                <th class="cred-col-base">API Base</th>
                ${showKeyColumn() ? '<th class="cred-col-key">API key</th>' : ''}
                <th class="cred-col-status">Status</th>
                <th class="cred-col-delete" aria-label="Delete"></th>
              </tr>
            </thead>
            <tbody>${credentialsMessageRow('No credentials added yet.')}</tbody>
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
 * - Right after a successful save: the same real check as the table's Status control
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

  let lastDetectKey = '';
  /** Models the entered Base URL / API key's provider reported; suggested first. */
  let endpointModels = [];

  function resetForm() {
    lastDetectKey = '';
    endpointModels = [];
  }

  // Cosmetic only: feeds the Model ID suggestions. Never sets what gets saved.
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
      endpointModels = (data.models || []).filter((m) => m && m.id);
    } catch (e) {
      // Suggestions are a nicety; silently skip on failure.
    }
  }

  modelInput?.addEventListener('blur', runDetect);
  baseUrlInput?.addEventListener('blur', runDetect);
  apiKeyInput?.addEventListener('blur', runDetect);

  // Suggesting doesn't need a key yet: litellm.model_cost is a static, offline catalog of known model
  // ids across providers. The key is still required at Add time.
  if (modelInput) {
    attachModelIdAutocomplete(modelInput, {
      loadCatalog: loadLiteLlmCatalog,
      getEndpointModels: () => endpointModels,
      describe: (m) => (endpointModels.includes(m)
        ? describeSuggestedModel(m, 'From your Base URL / API key')
        : describeSuggestedModel(m, PROVIDER_LABELS[m.provider] || m.provider)),
    });
  }

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
  const statusEl = addFormRoot.querySelector('#credentials-openrouter-status');
  const modelField = addFormRoot.querySelector('#credentials-openrouter-model-field');
  const modelInput = addFormRoot.querySelector('#credentials-openrouter-model');
  if (!statusEl) return;
  let pollTimer = null;
  let connectedCredentialId = null;

  /** The account line: a message, then optionally an action written as a link (Connect, Reconnect, Cancel…). */
  function showStatus(message, action = null) {
    const parts = [document.createTextNode(message)];
    if (action) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'credentials-openrouter-link';
      link.textContent = action.label;
      link.addEventListener('click', action.onClick);
      parts.push(document.createTextNode(' '), link);
    }
    statusEl.replaceChildren(...parts);
  }

  const connectAction = (label) => ({ label, onClick: onConnectClick });

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
      showStatus('Not connected.', connectAction('Connect to OpenRouter'));
      return;
    }
    const openRouterCreds = list.filter((c) => c.provider === 'openrouter');
    if (openRouterCreds.length === 0) {
      showStatus('Not connected.', connectAction('Connect to OpenRouter'));
      return;
    }
    showStatus('Checking connection…');
    for (const cred of openRouterCreds.slice().reverse()) { // most recently added first
      const ok = await runCredentialCheck(tableHost, cred.id);
      if (ok) {
        connectedCredentialId = cred.id;
        if (modelField) modelField.hidden = false;
        showStatus('Connected to OpenRouter.', connectAction('Reconnect'));
        return;
      }
    }
    showStatus('Your saved OpenRouter key no longer works.', connectAction('Connect again'));
  }
  checkExistingConnection();

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function onConnectClick() {
    showStatus('Opening OpenRouter…');
    if (modelField) modelField.hidden = true;
    connectedCredentialId = null;
    let started;
    try {
      const res = await fetch(`${API_BASE}/api/credentials/openrouter/start`, { method: 'POST' });
      started = await res.json().catch(() => ({}));
      if (!res.ok || !started.auth_url || !started.state) throw new Error('Could not start OpenRouter login.');
    } catch (e) {
      showStatus((e && e.message) || 'Could not start OpenRouter login.', connectAction('Try again'));
      return;
    }
    if (window.electronAPI?.openExternal) window.electronAPI.openExternal(started.auth_url);
    else window.open(started.auth_url, '_blank', 'noopener');
    showStatus('Waiting for approval in your browser…', {
      label: 'Cancel',
      onClick: () => {
        stopPolling();
        checkExistingConnection();
      },
    });
    const deadline = Date.now() + OPENROUTER_POLL_TIMEOUT_MS;
    pollTimer = setInterval(async () => {
      if (Date.now() > deadline) {
        stopPolling();
        showStatus('Timed out waiting for OpenRouter.', connectAction('Try again'));
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/credentials/openrouter/status/${started.state}`);
        const data = await res.json().catch(() => ({}));
        if (!pollTimer) return; // cancelled while this request was in flight
        if (data.status === 'done') {
          stopPolling();
          showStatus('Connected to OpenRouter.', connectAction('Reconnect'));
          connectedCredentialId = data.credential_id || null;
          if (modelField) modelField.hidden = !connectedCredentialId;
          await loadAndRenderCredentials(tableHost);
          tableHost._onCredentialsChange?.();
          if (data.credential_id) runCredentialCheck(tableHost, data.credential_id);
        } else if (data.status === 'error' || data.status === 'not_found') {
          stopPolling();
          showStatus(data.error || 'Could not complete the OpenRouter connection.', connectAction('Try again'));
        }
      } catch (e) {
        // Transient network hiccup while polling; keep trying until the timeout.
      }
    }, OPENROUTER_POLL_MS);
  }

  // OpenRouter's own live catalog (no key needed to browse it); picking only fills the Model ID field.
  if (modelInput) {
    attachModelIdAutocomplete(modelInput, {
      loadCatalog: loadOpenRouterCatalog,
      describe: (m) => describeSuggestedModel(m, m.name && m.name !== m.id ? m.name : ''),
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

  return { checkExistingConnection, submit: submitOpenRouterModel };
}

/* ——— Modal ——— */

export function openSettingsModal() {
  const isDesktop = Boolean(window.electronAPI);
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
                ${isDesktop ? '' : '<section class="settings-free-allowance" hidden aria-live="polite"><strong>Free allowance</strong><p class="settings-free-allowance-text"></p></section>'}
                <div id="model-settings-credentials-root"></div>
              </aside>
              <div class="model-settings-col model-settings-col-right" aria-labelledby="model-settings-col-settings-title">
                <div class="model-settings-main">
                  <div class="model-settings-tab-row">
                    <div class="review-detail-view-switch model-settings-view-switch" role="tablist" aria-label="Settings options">
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active" role="tab" aria-selected="true" aria-controls="settings-panel-credentials" id="settings-tab-credentials" data-tab="credentials">New credential</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-run" id="settings-tab-run" data-tab="run">Generate</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-review" id="settings-tab-review" data-tab="review">Optimize</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-agent" id="settings-tab-agent" data-tab="agent">Agent</button>
                    </div>
                  </div>
                  <div class="review-detail-tab-panels model-settings-tab-panels">
                    <div class="review-detail-tab-panel review-detail-tab-panel--active" id="settings-panel-credentials" role="tabpanel" aria-labelledby="settings-tab-credentials" data-panel="credentials">
                      <div class="defaults-page-scroll settings-credentials-tab-body">
                        <p class="settings-tab-intro">${isDesktop ? 'A credential is a model ID plus the API key that pays for it. Add one through LiteLLM, which reaches most providers and your own server through Base URL, or connect an OpenRouter account. Credentials appear on the left, where clicking a Status tests them, and can then be used by Generate nodes, Optimize nodes and the Agent.' : 'AnnoBio AI is included for text prompts and selected by default. Its daily token allowance is shared by Generate, Optimize and Agent. Connect OpenRouter to use your own models and continue after the free allowance is used. The desktop app also supports LiteLLM and custom endpoints.'}</p>
                        <div id="model-settings-credentials-add" class="model-settings-credentials-add">
                          <div class="credentials-add-method-row">
                            <label class="dataset-meta-label" for="credentials-add-method-select">Add credential</label>
                            <select id="credentials-add-method-select" class="dataset-meta-input credentials-add-method-select" aria-label="Add credential method">
                              ${isDesktop ? '<option value="litellm" selected>Via LiteLLM</option>' : ''}
                              <option value="openrouter" ${isDesktop ? '' : 'selected'}>Via OpenRouter</option>
                            </select>
                          </div>
                          <div class="credentials-add-tab-panels">
                            ${isDesktop ? `<div class="credentials-add-tab-panel credentials-add-tab-panel--active" id="credentials-add-panel-litellm" data-panel="litellm">
                              <div class="credentials-add-row">
                                <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                                  <label class="dataset-meta-label" for="credentials-model">Model ID</label>
                                  <div class="credentials-model-input-row model-id-autocomplete">
                                    <input type="text" id="credentials-model" class="dataset-meta-input" placeholder="Start typing, e.g. gpt-5 or claude-sonnet-4-6" autocomplete="off" aria-label="Model ID" />
                                  </div>
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
                            ` : ''}<div class="credentials-add-tab-panel${isDesktop ? '' : ' credentials-add-tab-panel--active'}" id="credentials-add-panel-openrouter" data-panel="openrouter">
                              <div class="credentials-add-row">
                                <div class="credentials-add-field credentials-add-field--full-row">
                                  <span class="dataset-meta-label" id="credentials-openrouter-account-label">OpenRouter account</span>
                                  <p class="credentials-add-openrouter-status" id="credentials-openrouter-status" aria-labelledby="credentials-openrouter-account-label" aria-live="polite"></p>
                                </div>
                                <div class="credentials-add-field credentials-add-field--full-row" id="credentials-openrouter-model-field" hidden>
                                  <label class="dataset-meta-label" for="credentials-openrouter-model">Model ID</label>
                                  <div class="credentials-model-input-row model-id-autocomplete">
                                    <input type="text" id="credentials-openrouter-model" class="dataset-meta-input" placeholder="Start typing, e.g. claude-sonnet-4.6" autocomplete="off" aria-label="Model ID" />
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
                          <p class="settings-tab-intro">A Generate sends its prompt to a model once per input row. Choose a model to see and change its Max tokens and Concurrency; the model chosen when you save is preselected when you create a Generate. With None chosen, they are the values for models that have none of their own. Max retries applies to every model. Running more rows at once finishes sooner but can hit the provider's rate limits. Advanced parameters, such as temperature, belong to the chosen model and list only what it takes.</p>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-run-credential">Model</label>
                              <select id="settings-default-run-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Generate">
                                <option value="">${selectPlaceholderLabel('None (select each time)')}</option>
                              </select>
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-run-max-tokens">Max tokens (256–131072)</label>
                              <input type="number" id="settings-run-max-tokens" class="dataset-meta-input" min="256" max="131072" value="8192" aria-label="Generate max tokens" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-run-max-retries">Max retries on error (0–5)</label>
                              <input type="number" id="settings-run-max-retries" class="dataset-meta-input" min="0" max="5" value="2" aria-label="Generate max retries" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-run-concurrency">Concurrency (1–10)</label>
                              <input type="number" id="settings-run-concurrency" class="dataset-meta-input" min="1" max="10" value="4" aria-label="Generate concurrency" />
                            </div>
                          </div>
                          <div class="settings-run-params" id="settings-run-params" hidden></div>
                      </div>
                    </div>
                    <div class="review-detail-tab-panel" id="settings-panel-review" role="tabpanel" aria-labelledby="settings-tab-review" data-panel="review">
                      <div class="defaults-page-scroll">
                          <p class="settings-tab-intro">An Optimize node studies the rows an Evaluate node marked wrong and suggests edits to the prompt. Choose a model to see and change its Max tokens; the model chosen when you save is preselected when you start an Optimize. With None chosen, it is the value for models that have none of their own. The other settings, including the method, apply to every Optimize. Larger limits can find better edits but make more model calls.</p>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-review-credential">Model</label>
                              <select id="settings-default-review-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Optimize">
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
                              <input type="number" id="settings-review-max-tokens" class="dataset-meta-input" min="256" max="131072" value="32768" aria-label="Optimize max tokens" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-failed-rows">Max failed inputs per Optimize (1–200)</label>
                              <input type="number" id="settings-review-max-failed-rows" class="dataset-meta-input" min="1" max="200" value="30" aria-label="Max inputs with failures analyzed per Optimize" />
                            </div>
                            <div class="defaults-field settings-review-method-specific" data-method-settings="issue_analysis_suggestions" hidden>
                              <label class="dataset-meta-label" for="settings-optimization-max-trials">Max trials per optimization run (4–200)</label>
                              <input type="number" id="settings-optimization-max-trials" class="dataset-meta-input" min="4" max="200" value="40" aria-label="Optimization max Thompson-sampling trials" title="Only used by the built-in method's suggestion-card 'Optimize' pill (Thompson-sampling segment search) — no other review method reads this." />
                            </div>
                            <!-- Hidden: a developer switch. Its saved value still applies (Restore defaults turns it off). -->
                            <div class="defaults-field defaults-field--full" style="margin-top:0.5rem;" hidden>
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
                          <p class="settings-tab-intro">The Agent Assistant is the chat in the right panel. Its model must support tool calling, so choosing one runs a quick check. The model chosen when you save is the one the Agent uses; with None it uses the Optimize model. Replies are capped by that model's Max tokens on the Optimize tab, up to 8,192. Context window limits how much of a long chat is sent each time, and belongs to the chosen model; Auto uses the model's own limit.</p>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-agent-credential">Model</label>
                              <select id="settings-default-agent-credential" class="credentials-select dataset-meta-input" aria-label="Default model for the Agent window">
                                <option value="">${selectPlaceholderLabel('None (select each time)')}</option>
                              </select>
                              <div class="settings-agent-model-status" id="settings-agent-model-status" aria-live="polite">
                                <span class="settings-agent-model-status__text"></span>
                                <button type="button" class="btn btn-secondary settings-agent-model-status__check" hidden>Check again</button>
                              </div>
                            </div>
                          </div>
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-agent-context-tokens">Context window (tokens)</label>
                              <input type="number" id="settings-agent-context-tokens" class="dataset-meta-input" min="4096" max="2000000" step="1000" placeholder="Auto" aria-describedby="settings-agent-context-hint" />
                              <div class="settings-agent-model-status" id="settings-agent-context-hint" aria-live="polite">
                                <span class="settings-agent-model-status__text"></span>
                              </div>
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
  // Drawn with a pill per model saying whether it works with the Agent (pillSelect.js).
  const agentModelPicker = agentCredSelect ? mountPillSelect(agentCredSelect) : null;
  const agentStatusEl = overlay.querySelector('#settings-agent-model-status');
  const agentStatusText = agentStatusEl?.querySelector('.settings-agent-model-status__text');
  const agentCheckBtn = agentStatusEl?.querySelector('.settings-agent-model-status__check');
  const agentContextInp = overlay.querySelector('#settings-agent-context-tokens');
  const agentContextHintText = overlay.querySelector('#settings-agent-context-hint .settings-agent-model-status__text');
  /** Credentials as last loaded, and registry hints on tool calling (/api/credentials/agent-hints). */
  let agentCredentials = [];
  let agentHints = {};
  const agentChecksInFlight = new Set();
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

  /*
   * The model chosen at the top of the Generate, Optimize and Agent tabs is the default model, and these
   * fields show and edit that model's own values (perModelSettings.js). Saved as model_settings.
   */
  const modelState = { shared: {}, modelSettings: {} };
  let credentialIds = [];
  /*
   * The chosen Generate model's generation parameters (runParams.js): only those the model takes are
   * listed (GET /api/credentials/{id}/run-params), each blank for the model's default. Saved in
   * modelState as model_settings[id].run_params; Optimize and the Agent do not use them.
   */
  const runParamsRow = overlay.querySelector('#settings-run-params');
  const runParamSpecs = new Map();
  let runParamsShown = { id: '', specs: [] };
  let runParamsRequest = 0;
  let runParamsOpen = false; // collapsed until opened; stays as the user left it while Settings is open

  /** "· 2 set" beside the collapsed heading: how many fields hold a value. */
  function renderRunParamsCount() {
    const count = runParamsShown.specs.filter((spec) => {
      const field = runParamsRow.querySelector(`[data-param="${spec.name}"]`);
      return field && paramValue(spec, field.value) != null;
    }).length;
    const label = runParamsRow.querySelector('.settings-run-params__count');
    if (label) label.textContent = count ? `· ${count} set` : '';
  }

  function loadRunParamSpecs(credentialId) {
    if (!runParamSpecs.has(credentialId)) {
      runParamSpecs.set(credentialId, fetch(`${API_BASE}/api/credentials/${encodeURIComponent(credentialId)}/run-params`)
        .then((res) => (res.ok ? res.json() : { params: [] }))
        .then((data) => (Array.isArray(data?.params) ? data.params : []))
        .catch(() => []));
    }
    return runParamSpecs.get(credentialId);
  }

  /** Keeps what the parameter fields say for the model they show. */
  function stashRunParams() {
    const { id, specs } = runParamsShown;
    if (!id) return;
    const values = {};
    for (const spec of specs) {
      const field = runParamsRow.querySelector(`[data-param="${spec.name}"]`);
      values[spec.name] = field ? paramValue(spec, field.value) : null;
    }
    modelState.modelSettings = withRunParams(modelState.modelSettings, id, values);
  }

  async function showRunParams() {
    const request = ++runParamsRequest;
    const id = (runCredSelect.value || '').trim();
    runParamsShown = { id: '', specs: [] };
    runParamsRow.hidden = true;
    runParamsRow.innerHTML = '';
    if (!id) return;
    const specs = await loadRunParamSpecs(id);
    if (request !== runParamsRequest || !specs.length) return;
    const own = modelState.modelSettings[id]?.run_params || {};
    const fields = specs.map((spec) => {
      const fieldId = `settings-run-param-${spec.name}`;
      const value = own[spec.name] ?? '';
      const control = spec.type === 'choice'
        ? `<select id="${fieldId}" class="credentials-select dataset-meta-input" data-param="${escapeHtml(spec.name)}">
            <option value="">Model default</option>
            ${spec.choices.map((choice) => `<option value="${escapeHtml(choice)}"${choice === value ? ' selected' : ''}>${escapeHtml(choice)}</option>`).join('')}
          </select>`
        : `<input type="number" id="${fieldId}" class="dataset-meta-input" data-param="${escapeHtml(spec.name)}"
            min="${spec.min}" max="${spec.max}" step="${spec.type === 'integer' ? 1 : 'any'}" placeholder="Model default"
            value="${escapeHtml(String(value))}" />`;
      return `<div class="defaults-field" title="${escapeHtml(spec.help || '')}">
          <label class="dataset-meta-label" for="${fieldId}">${escapeHtml(paramLabel(spec))}</label>
          ${control}
        </div>`;
    }).join('');
    runParamsRow.innerHTML = `<details class="settings-run-params__details"${runParamsOpen ? ' open' : ''}>
        <summary class="settings-run-params__summary">Advanced parameters <span class="settings-run-params__count"></span></summary>
        <p class="settings-run-params__hint">Leave a field empty to use the model's default.</p>
        <div class="defaults-row">${fields}</div>
      </details>`;
    const details = runParamsRow.querySelector('details');
    details.addEventListener('toggle', () => { runParamsOpen = details.open; });
    details.addEventListener('input', renderRunParamsCount);
    details.addEventListener('change', renderRunParamsCount);
    runParamsShown = { id, specs };
    renderRunParamsCount();
    runParamsRow.hidden = false;
  }

  runCredSelect.addEventListener('change', () => {
    stashRunParams();
    void showRunParams();
  });

  const modelFieldBindings = [
    bindModelFields({ select: runCredSelect, inputs: { run_max_tokens: runMaxTokensInp, run_concurrency: runConcurrencyInp }, state: modelState }),
    bindModelFields({ select: reviewCredSelect, inputs: { review_max_tokens: reviewMaxTokensInp }, state: modelState }),
    bindModelFields({ select: agentCredSelect, inputs: { agent_context_tokens: agentContextInp }, state: modelState }),
  ];

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

  async function loadFreeAllowance() {
    const section = overlay.querySelector('.settings-free-allowance');
    if (!section) return;
    try {
      const response = await fetch(`${API_BASE}/api/hosted-model`);
      if (!response.ok) return;
      const allowance = await response.json();
      if (!allowance.enabled) return;
      section.hidden = false;
      const text = section.querySelector('.settings-free-allowance-text');
      const ownModel = 'add an OpenRouter credential under New credential';
      if (!allowance.available) {
        text.textContent = `The free model is temporarily unavailable. To use your own model, ${ownModel}.`;
      } else {
        const reset = allowance.resets_at ? ` Resets ${new Date(allowance.resets_at).toLocaleString()}.` : '';
        text.textContent = allowance.remaining > 0
          ? `${Number(allowance.remaining).toLocaleString()} of ${Number(allowance.limit).toLocaleString()} daily tokens remaining.${reset}`
          : `Your daily free token allowance has been reached.${reset}`;
        if (allowance.reserved) text.textContent += ' Active requests are using part of this allowance.';
        if (allowance.estimated) text.textContent += ' Interrupted requests include estimated usage.';
        text.textContent += ` To use your own model, ${ownModel}.`;
      }
    } catch { /* The rest of Settings stays available during a usage-service outage. */ }
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
    agentCredentials = credentials;
    renderAgentCredentialOptions();
    credentialIds = credentials.map((c) => c.id);
  }

  /*
   * The Agent needs a model that calls tools. Which model a user brings is unknown, so the picker
   * shows what a live check found (POST /api/credentials/{id}/agent-check, run when a model is
   * chosen), and until then only what the provider's model registry suggests.
   */
  /** The pill beside a model in the picker: [text, kind] or null. */
  function agentModelPill(c) {
    if (c.agent_check_ok === true) return ['Works with the Agent', 'ok'];
    if (c.agent_check_ok === false) return ['Cannot call tools', 'error'];
    if (agentHints[c.id] === false) return ['Tool calling unlikely', 'warning'];
    return null;
  }

  function renderAgentCredentialOptions() {
    if (!agentCredSelect) return;
    const selected = agentCredSelect.value;
    agentCredSelect.innerHTML = `<option value="">${selectPlaceholderLabel('None (select each time)')}</option>`
      + agentCredentials.map((c) => {
        const pill = agentModelPill(c);
        const pillAttrs = pill ? ` data-pill="${escapeHtml(pill[0])}" data-pill-kind="${pill[1]}"` : '';
        return `<option value="${escapeHtml(c.id)}"${pillAttrs}>${escapeHtml(c.model || c.llm || c.id)}</option>`;
      }).join('');
    agentCredSelect.value = selected;
    renderAgentModelStatus();
  }

  function renderAgentModelStatus(checkError = '') {
    agentModelPicker?.refresh();
    if (!agentStatusEl) return;
    const c = agentCredentials.find((item) => item.id === agentCredSelect.value);
    let text;
    let state = 'neutral';
    if (!c) {
      text = 'Without a default, the Agent uses the default Optimize model.';
    } else if (agentChecksInFlight.has(c.id)) {
      text = 'Checking whether this model can call tools...';
    } else if (checkError) {
      text = `Could not check this model: ${checkError}`;
      state = 'warning';
    } else if (c.agent_check_ok === true) {
      // The picker's "Works with the Agent" pill already says it; no status line or re-check.
      agentStatusEl.hidden = true;
      return;
    } else if (c.agent_check_ok === false) {
      text = `Cannot drive the Agent: ${c.agent_check_detail || 'it does not call tools.'}`;
      state = 'error';
    } else {
      const hint = agentHints[c.id];
      text = `Not checked yet. ${hint === true ? 'Its provider lists tool calling for it.' : hint === false ? 'Its provider does not list tool calling for it.' : 'There is no published information on its tool calling.'}`;
    }
    agentStatusEl.hidden = false;
    agentStatusEl.dataset.state = state;
    agentStatusText.textContent = text;
    agentCheckBtn.hidden = !c || c.builtin === true || agentChecksInFlight.has(c.id);
    agentCheckBtn.textContent = c?.agent_check_ok == null && !checkError ? 'Check' : 'Check again';
  }

  async function runAgentModelCheck(credentialId) {
    if (agentCredentials.find(c => c.id === credentialId)?.builtin) return;
    if (!credentialId || agentChecksInFlight.has(credentialId)) return;
    agentChecksInFlight.add(credentialId);
    renderAgentModelStatus();
    let checkError = '';
    try {
      const res = await fetch(`${API_BASE}/api/credentials/${encodeURIComponent(credentialId)}/agent-check`, { method: 'POST' });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) checkError = result?.detail || res.statusText;
      else if (result.ok == null) checkError = result.detail || 'unknown error';
      else {
        const c = agentCredentials.find((item) => item.id === credentialId);
        if (c) {
          c.agent_check_ok = result.ok;
          c.agent_check_detail = result.detail;
        }
      }
    } catch (e) {
      checkError = e instanceof Error ? e.message : String(e);
    } finally {
      agentChecksInFlight.delete(credentialId);
    }
    renderAgentCredentialOptions();
    if (agentCredSelect.value === credentialId) renderAgentModelStatus(checkError);
  }

  async function loadAgentHints() {
    try {
      const res = await fetch(`${API_BASE}/api/credentials/agent-hints`);
      agentHints = res.ok ? await res.json() : {};
    } catch (_) {
      agentHints = {};
    }
    renderAgentCredentialOptions();
  }

  /** What Auto means for the selected model (GET /api/agent/context), and what the setting does. */
  let agentContextHintRequest = 0;
  async function renderAgentContextHint() {
    if (!agentContextHintText) return;
    const request = ++agentContextHintRequest;
    const credentialId = (agentCredSelect?.value || '').trim();
    const info = await fetchAgentContext(credentialId);
    if (request !== agentContextHintRequest) return;
    const fallback = (info?.fallback_tokens || 32000).toLocaleString();
    let auto;
    if (!credentialId) auto = `Auto uses the model's context window from the model registries (${fallback} if unknown).`;
    else if (info?.detected_tokens) auto = `Auto: ${info.detected_tokens.toLocaleString()} tokens for this model.`;
    else auto = `Auto: this model's context window is unknown, so ${fallback} tokens are assumed.`;
    agentContextHintText.textContent = `${auto} When a conversation outgrows it, earlier tool results are shortened first, then the oldest messages are left out.`;
  }

  agentCredSelect?.addEventListener('change', () => {
    const c = agentCredentials.find((item) => item.id === agentCredSelect.value);
    renderAgentModelStatus();
    void renderAgentContextHint();
    // Choosing a model checks it once (one small model call); a known result is not re-checked.
    if (c && c.agent_check_ok == null) void runAgentModelCheck(c.id);
  });
  agentCheckBtn?.addEventListener('click', () => { void runAgentModelCheck(agentCredSelect.value); });

  function applySettings(settings) {
    if (!settings) return;
    runCredSelect.value = settings.default_run_credential_id || '';
    reviewCredSelect.value = settings.default_review_credential_id || '';
    if (agentCredSelect) {
      agentCredSelect.value = settings.default_agent_credential_id || '';
      renderAgentModelStatus();
      void renderAgentContextHint();
    }
    if (agentContextInp) agentContextInp.value = settings.agent_context_tokens ? String(settings.agent_context_tokens) : '';
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
    // A loaded settings object (not Restore defaults) replaces what the model fields edit.
    if (settings.model_settings) {
      modelState.modelSettings = { ...settings.model_settings };
      modelState.shared = Object.fromEntries(Object.keys(PER_MODEL_FIELDS).map((key) => [key, settings[key] ?? MODEL_SETTINGS_DEFAULTS[key]]));
      modelFieldBindings.forEach((binding) => binding.load());
      void showRunParams();
    }
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
        modelFieldBindings.forEach((binding) => binding.stash());
        stashRunParams();
        runParamSpecs.clear(); // a model ID may have changed
        const credentials = await loadCredentials();
        populateCredentialSelects(credentials);
        // A deleted model can no longer be chosen: its tab falls back to None.
        const choose = (select, id) => {
          if (!select) return;
          select.value = id;
          if (select.selectedIndex < 0) select.value = '';
        };
        choose(runCredSelect, ids.run);
        choose(reviewCredSelect, ids.review);
        choose(agentCredSelect, ids.agent);
        renderAgentModelStatus();
        modelFieldBindings.forEach((binding) => binding.load());
        void showRunParams();
        void loadAgentHints();
      },
    });
    const liteLlmAdd = isDesktop ? wireCredentialsAddForm(addRoot, credRoot) : null;
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
    if (!isDesktop) {
      void loadFreeAllowance();
    }
    void loadAgentHints();
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
    // Blank means Auto (0); anything else is kept within what the input allows.
    const agentContextParsed = parseInt(agentContextInp?.value, 10);
    const agentContextTokens = Number.isNaN(agentContextParsed) ? 0 : Math.min(2000000, Math.max(4096, agentContextParsed));
    const simbaMaxStepsParsed = parseInt(simbaMaxStepsInp?.value, 10);
    const simbaMaxSteps = Math.min(40, Math.max(2, Number.isNaN(simbaMaxStepsParsed) ? MODEL_SETTINGS_DEFAULTS.simba_max_steps : simbaMaxStepsParsed));
    return {
      default_run_credential_id: (runCredSelect.value || '').trim() || '',
      default_review_credential_id: (reviewCredSelect.value || '').trim() || '',
      default_agent_credential_id: (agentCredSelect?.value || '').trim() || '',
      agent_context_tokens: agentContextTokens,
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
      // The model fields on the page show the chosen model's values; the shared ones come from modelState.
      ...modelState.shared,
      model_settings: keepKnownModels(modelState.modelSettings, credentialIds),
    };
  }

  async function doSave() {
    modelFieldBindings.forEach((binding) => binding.stash());
    stashRunParams();
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
  // Puts the factory values in the fields, for the chosen models only once saved; the chosen models stay.
  overlay.querySelector('#settings-restore-defaults')?.addEventListener('click', () => {
    applySettings({
      ...MODEL_SETTINGS_DEFAULTS,
      default_run_credential_id: runCredSelect.value,
      default_review_credential_id: reviewCredSelect.value,
      default_agent_credential_id: agentCredSelect?.value || '',
    });
    // Factory values for the parameters are the model's own defaults.
    runParamsRow.querySelectorAll('[data-param]').forEach((field) => { field.value = ''; });
    renderRunParamsCount();
  });
  overlay.querySelector('#settings-save')?.addEventListener('click', async () => {
    await doSave();
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  init().catch((e) => console.error('Model settings init:', e));
}
