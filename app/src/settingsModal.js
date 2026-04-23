/**
 * Model settings modal: credentials table (left, always visible); Runner / Reviewer / add-credentials (right tabs).
 * APIs: /api/credentials, /api/settings.
 */

import { showAlert, showConfirm } from './alertModal.js';
import { selectPlaceholderLabel } from './displayTextNormalize.js';
import { BACKEND_API_BASE } from './backendConfig.js';

const API_BASE = BACKEND_API_BASE;

/** Must stay aligned with backend DEFAULT_SETTINGS in main.py */
const MODEL_SETTINGS_DEFAULTS = {
  default_run_credential_id: '',
  default_review_credential_id: '',
  run_max_tokens: 8192,
  review_max_tokens: 32768,
  run_max_retries: 2,
  /** Distinct inputs with ≥1 unmatched comparison row; Phase 1 analyzes at most this many. */
  review_max_failed_rows: 30,
  /** Thompson-sampling trials per compositional finetune run (4–200). */
  finetune_max_trials: 40,
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
      <td>${escapeHtml(credentialModelLabel(c))}</td>
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

function bindCredTestButtons(scope) {
  scope.querySelectorAll('.credentials-test-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  scope.querySelectorAll('.credentials-test-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      const origText = btn.textContent;
      btn.textContent = 'Testing';
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/api/credentials/${id}/test`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showAlert('API key valid.', { title: 'Test result' });
        } else {
          showAlert(typeof data.detail === 'string' ? data.detail : 'Test failed', { title: 'Test failed' });
          console.warn('Test failed:', data.detail || res.statusText);
        }
      } catch (e) {
        showAlert((e && e.message) || 'Test failed', { title: 'Test failed' });
        console.error('Test credential:', e);
      } finally {
        btn.textContent = origText;
        btn.disabled = false;
      }
    });
  });
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
 * @param {HTMLElement} addFormRoot
 * @param {HTMLElement} tableHost
 */
function wireCredentialsAddForm(addFormRoot, tableHost) {
  async function onAddCredentialSubmit() {
    const modelInput = addFormRoot.querySelector('#credentials-model');
    const baseUrlInput = addFormRoot.querySelector('#credentials-base-url');
    const apiKeyInput = addFormRoot.querySelector('#credentials-api-key');
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
        body: JSON.stringify({
          model: llm,
          base_url,
          api_key,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = typeof err.detail === 'string' ? err.detail : Array.isArray(err.detail) ? err.detail.map((d) => d?.msg || String(d)).join(', ') : 'Add failed';
        showAlert(msg, { title: 'Add credential failed' });
        return;
      }
      apiKeyInput.value = '';
      if (modelInput) modelInput.value = '';
      if (baseUrlInput) baseUrlInput.value = '';
      await loadAndRenderCredentials(tableHost);
      tableHost._onCredentialsChange?.();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      showAlert(msg, { title: 'Add credential failed' });
      console.error('Add credential:', e);
    }
  }

  const footerAdd = addFormRoot.closest('.model-settings-col-right')?.querySelector('#settings-footer-add');
  footerAdd?.addEventListener('click', onAddCredentialSubmit);
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
        <h2 id="model-settings-title" class="modal-title">Model settings</h2>
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
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-run" id="settings-tab-run" data-tab="run">Run</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-review" id="settings-tab-review" data-tab="review">Review</button>
                    </div>
                  </div>
                  <div class="review-detail-tab-panels model-settings-tab-panels">
                    <div class="review-detail-tab-panel review-detail-tab-panel--active" id="settings-panel-credentials" role="tabpanel" aria-labelledby="settings-tab-credentials" data-panel="credentials">
                      <div class="defaults-page-scroll settings-credentials-tab-body">
                        <div id="model-settings-credentials-add" class="model-settings-credentials-add">
                          <div class="credentials-add-row">
                            <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                              <label class="dataset-meta-label" for="credentials-model">Model ID</label>
                              <input type="text" id="credentials-model" class="dataset-meta-input" placeholder="e.g. gpt-5, anthropic/claude-sonnet-4-6" autocomplete="off" aria-label="Model ID" />
                            </div>
                            <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                              <label class="dataset-meta-label" for="credentials-base-url">Base URL (optional)</label>
                              <input type="text" id="credentials-base-url" class="dataset-meta-input" placeholder="OpenAI-compatible endpoint" autocomplete="off" aria-label="Base URL" />
                            </div>
                            <div class="credentials-add-field credentials-add-field--grow credentials-add-field--full-row">
                              <label class="dataset-meta-label" for="credentials-api-key">API key</label>
                              <input type="text" id="credentials-api-key" class="dataset-meta-input credentials-api-key-input" placeholder="Paste your API key" autocomplete="off" />
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
                          </div>
                      </div>
                    </div>
                    <div class="review-detail-tab-panel" id="settings-panel-review" role="tabpanel" aria-labelledby="settings-tab-review" data-panel="review">
                      <div class="defaults-page-scroll">
                          <div class="defaults-row">
                            <div class="defaults-field defaults-field--full">
                              <p class="dataset-meta-label" style="margin-bottom:0.35rem;font-weight:600;">Models &amp; limits</p>
                            </div>
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-review-credential">Default model</label>
                              <select id="settings-default-review-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Review">
                                <option value="">${selectPlaceholderLabel('None (select each time)')}</option>
                              </select>
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-tokens">Max tokens (256–131072)</label>
                              <input type="number" id="settings-review-max-tokens" class="dataset-meta-input" min="256" max="131072" value="32768" aria-label="Review max tokens" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-failed-rows">Max failed inputs per Review (1–200)</label>
                              <input type="number" id="settings-review-max-failed-rows" class="dataset-meta-input" min="1" max="200" value="30" aria-label="Max inputs with failures analyzed per Review" />
                            </div>
                            <div class="defaults-field defaults-field--full">
                              <p class="dataset-meta-label" style="margin-bottom:0.35rem;font-weight:600;">Finetune</p>
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-finetune-max-trials">Max trials per finetune run (4–200)</label>
                              <input type="number" id="settings-finetune-max-trials" class="dataset-meta-input" min="4" max="200" value="40" aria-label="Finetune max Thompson-sampling trials" />
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
  const runMaxTokensInp = overlay.querySelector('#settings-run-max-tokens');
  const reviewMaxTokensInp = overlay.querySelector('#settings-review-max-tokens');
  const reviewMaxFailedRowsInp = overlay.querySelector('#settings-review-max-failed-rows');
  const runMaxRetriesInp = overlay.querySelector('#settings-run-max-retries');
  const finetuneMaxTrialsInp = overlay.querySelector('#settings-finetune-max-trials');
  const debugModeChk = overlay.querySelector('#settings-debug-mode');
  const tabBar = overlay.querySelector('.model-settings-view-switch');
  const tabs = tabBar ? tabBar.querySelectorAll('.review-detail-tab[data-tab]') : [];
  const panels = overlay.querySelectorAll('.model-settings-tab-panels .review-detail-tab-panel[data-panel]');
  const footerSaveRestore = overlay.querySelector('#model-settings-footer-save-restore');
  const footerAdd = overlay.querySelector('#settings-footer-add');

  function activateSettingsTab(name) {
    const n = name === 'run' || name === 'review' || name === 'credentials' ? name : 'credentials';
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

  function populateCredentialSelects(credentials) {
    const optHtml = credentials.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.model || c.llm || c.id)}</option>`
    ).join('');
    const optNone = `<option value="">${selectPlaceholderLabel('None (select each time)')}</option>`;
    runCredSelect.innerHTML = optNone + optHtml;
    reviewCredSelect.innerHTML = optNone + optHtml;
  }

  function applySettings(settings) {
    if (!settings) return;
    runCredSelect.value = settings.default_run_credential_id || '';
    reviewCredSelect.value = settings.default_review_credential_id || '';
    runMaxTokensInp.value = String(settings.run_max_tokens ?? MODEL_SETTINGS_DEFAULTS.run_max_tokens);
    reviewMaxTokensInp.value = String(settings.review_max_tokens ?? MODEL_SETTINGS_DEFAULTS.review_max_tokens);
    reviewMaxFailedRowsInp.value = String(settings.review_max_failed_rows ?? MODEL_SETTINGS_DEFAULTS.review_max_failed_rows);
    runMaxRetriesInp.value = String(settings.run_max_retries ?? MODEL_SETTINGS_DEFAULTS.run_max_retries);
    finetuneMaxTrialsInp.value = String(settings.finetune_max_trials ?? MODEL_SETTINGS_DEFAULTS.finetune_max_trials);
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
        };
        const credentials = await loadCredentials();
        populateCredentialSelects(credentials);
        runCredSelect.value = ids.run;
        reviewCredSelect.value = ids.review;
      },
    });
    wireCredentialsAddForm(addRoot, credRoot);
    const [credentials, settings] = await Promise.all([loadCredentials(), loadSettings()]);
    populateCredentialSelects(credentials);
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
    const finetuneMaxTrialsParsed = parseInt(finetuneMaxTrialsInp.value, 10);
    const finetuneMaxTrials = Math.min(200, Math.max(4, Number.isNaN(finetuneMaxTrialsParsed) ? MODEL_SETTINGS_DEFAULTS.finetune_max_trials : finetuneMaxTrialsParsed));
    return {
      default_run_credential_id: (runCredSelect.value || '').trim() || '',
      default_review_credential_id: (reviewCredSelect.value || '').trim() || '',
      run_max_tokens: runMaxTokens,
      review_max_tokens: reviewMaxTokens,
      review_max_failed_rows: reviewMaxFailedRows,
      run_max_retries: runMaxRetries,
      finetune_max_trials: finetuneMaxTrials,
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
