/**
 * Model settings modal: credentials table (left, always visible); Runner / Reviewer / add-credentials (right tabs).
 * APIs: /api/credentials, /api/settings.
 */

import { showAlert, showConfirm } from './alertModal.js';
import { selectPlaceholderLabel } from './displayTextNormalize.js';

const API_BASE = 'http://localhost:8000';

/** Must stay aligned with backend DEFAULT_SETTINGS in main.py */
const MODEL_SETTINGS_DEFAULTS = {
  default_run_credential_id: '',
  default_review_credential_id: '',
  default_review_assistant_credential_id: '',
  run_concurrency: 1,
  review_concurrency: 1,
  run_max_tokens: 8192,
  review_max_tokens: 32768,
  run_max_retries: 2,
  review_max_failed_rows: 30,
  review_finetune_max_trials: 22,
  review_finetune_num_candidates: 10,
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* ——— Credentials panel (table left, add form right) ——— */

const CREDENTIAL_PROVIDERS = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'bedrock', name: 'Amazon Bedrock' },
];

const CREDENTIAL_MODELS = [
  { id: 'gpt-5', name: 'gpt-5', provider: 'openai' },
  { id: 'gpt-5-mini', name: 'gpt-5-mini', provider: 'openai' },
  { id: 'gpt-5-nano', name: 'gpt-5-nano', provider: 'openai' },
  { id: 'claude-opus-4-6', name: 'claude-opus-4-6', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'anthropic' },
  { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', provider: 'google' },
  { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash', provider: 'google' },
  { id: 'gemini-2.5-flash-lite', name: 'gemini-2.5-flash-lite', provider: 'google' },
  { id: 'openai.gpt-oss-20b-1:0', name: 'openai.gpt-oss-20b-1:0', provider: 'bedrock' },
  { id: 'openai.gpt-oss-120b-1:0', name: 'openai.gpt-oss-120b-1:0', provider: 'bedrock' },
  { id: 'deepseek-chat', name: 'deepseek-chat', provider: 'deepseek' },
  { id: 'deepseek-reasoner', name: 'deepseek-reasoner', provider: 'deepseek' },
  { id: 'mistral-large-2512', name: 'mistral-large-2512', provider: 'mistral' },
];

function getCredTbody(scope) {
  return scope.querySelector('.credentials-table tbody');
}

function renderCredentialsTable(scope, list) {
  const tbody = getCredTbody(scope);
  if (!tbody) return;
  const providerName = (id) => (scope._providersMap && scope._providersMap[id]) || id || '—';
  const modelLabel = (v) => (scope._modelsMap && scope._modelsMap[v] && scope._modelsMap[v].name) || v || '—';
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="5">No credentials added yet.</td></tr>';
    return;
  }
  const maskedPlaceholder = '••••••••';
  tbody.innerHTML = list.map((c) => `
    <tr data-credential-id="${c.id}">
      <td class="credentials-name-cell">${escapeHtml(c.name || 'Unnamed')}</td>
      <td class="credentials-provider-cell">${escapeHtml(providerName(c.provider))}</td>
      <td>${escapeHtml(modelLabel(c.llm))}</td>
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
    bindCredNameCellClick(scope);
    bindCredKeyCellClick(scope);
    bindCredTestButtons(scope);
    bindCredDeleteButtons(scope);
  } catch (e) {
    console.error('Load credentials:', e);
    const tbody = getCredTbody(scope);
    if (tbody) tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="5">Unable to load (is the backend running?).</td></tr>';
  }
}

function notifyCredentialsPanelChanged(el) {
  const panel = el?.closest?.('.credentials-panel-host');
  panel?._onCredentialsChange?.();
}

function openCredNameEditInCell(id, nameCell, currentName) {
  if (nameCell.querySelector('.credentials-cell-edit-wrap')) return;
  const wrap = document.createElement('div');
  wrap.className = 'credentials-cell-edit-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.setAttribute('aria-label', 'Name');
  const doSave = async () => {
    const trimmed = input.value.trim();
    wrap.remove();
    if (!trimmed) {
      nameCell.textContent = currentName;
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/credentials/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        nameCell.textContent = trimmed;
        notifyCredentialsPanelChanged(nameCell);
      } else {
        nameCell.textContent = currentName;
      }
    } catch (e) {
      console.error('Rename credential:', e);
      nameCell.textContent = currentName;
    }
  };
  input.addEventListener('blur', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); wrap.remove(); nameCell.textContent = currentName; }
  });
  wrap.appendChild(input);
  nameCell.textContent = '';
  nameCell.appendChild(wrap);
  input.focus();
  input.select();
}

function bindCredNameCellClick(scope) {
  scope.querySelectorAll('.credentials-name-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const row = cell.closest('tr');
      const id = row?.getAttribute('data-credential-id');
      if (!id) return;
      const currentName = (cell.textContent || '').trim();
      openCredNameEditInCell(id, cell, currentName);
    });
  });
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
                <th>Name</th>
                <th>Provider</th>
                <th>Model type</th>
                <th>API key</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr class="credentials-table-empty">
                <td colspan="5">No credentials added yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  tableHost._onCredentialsChange = typeof options.onCredentialsChange === 'function' ? options.onCredentialsChange : undefined;

  return (async () => {
    tableHost._providers = CREDENTIAL_PROVIDERS;
    tableHost._models = CREDENTIAL_MODELS;
    tableHost._providersMap = Object.fromEntries(CREDENTIAL_PROVIDERS.map((p) => [p.id, p.name]));
    tableHost._modelsMap = Object.fromEntries(CREDENTIAL_MODELS.map((m) => [m.id, m]));
    await loadAndRenderCredentials(tableHost);
  })();
}

/**
 * Add-credential form in Settings tab; submit via #settings-footer-add in the modal footer.
 * @param {HTMLElement} addFormRoot
 * @param {HTMLElement} tableHost
 */
function wireCredentialsAddForm(addFormRoot, tableHost) {
  function fillProviderSelect() {
    const sel = addFormRoot.querySelector('#credentials-provider-select');
    if (!sel || !tableHost._providers) return;
    const placeholder = `<option value="">${selectPlaceholderLabel('Select provider')}</option>`;
    const optionsHtml = tableHost._providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.innerHTML = placeholder + optionsHtml;
    fillModelSelect();
  }

  function fillModelSelect() {
    const providerSel = addFormRoot.querySelector('#credentials-provider-select');
    const modelSel = addFormRoot.querySelector('#credentials-model-select');
    if (!modelSel || !tableHost._models) return;
    const providerId = (providerSel && providerSel.value) || '';
    const modelsForProvider = providerId ? tableHost._models.filter((m) => m.provider === providerId) : [];
    const customOption = providerId ? `<option value="__custom__">${selectPlaceholderLabel('Custom')}</option>` : '';
    modelSel.innerHTML = `<option value="">${selectPlaceholderLabel('Select model type')}</option>` + modelsForProvider.map((m) => `<option value="${m.id}">${m.name}</option>`).join('') + customOption;
    toggleModelCustomVisibility();
  }

  function toggleModelCustomVisibility() {
    const modelSel = addFormRoot.querySelector('#credentials-model-select');
    const presetWrap = addFormRoot.querySelector('.credentials-model-preset-wrap');
    const customWrap = addFormRoot.querySelector('#credentials-model-custom-wrap');
    const isCustom = modelSel?.value === '__custom__';
    if (presetWrap) presetWrap.classList.toggle('is-hidden', isCustom);
    if (customWrap) customWrap.classList.toggle('is-visible', isCustom);
  }

  async function onAddCredentialSubmit() {
    const providerSelect = addFormRoot.querySelector('#credentials-provider-select');
    const modelSelect = addFormRoot.querySelector('#credentials-model-select');
    const modelCustomInput = addFormRoot.querySelector('#credentials-model-custom');
    const apiKeyInput = addFormRoot.querySelector('#credentials-api-key');
    const provider = (providerSelect?.value || '').trim();
    const modelValue = (modelSelect?.value || '').trim();
    const llm = modelValue === '__custom__' ? (modelCustomInput?.value || '').trim() : modelValue;
    const api_key = (apiKeyInput?.value || '').trim();
    if (!provider) {
      console.warn('Please select a provider');
      return;
    }
    if (!llm) {
      console.warn('Please select a model type or enter a custom model ID');
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
        body: JSON.stringify({ provider, llm, api_key }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = typeof err.detail === 'string' ? err.detail : Array.isArray(err.detail) ? err.detail.map((d) => d?.msg || String(d)).join(', ') : 'Add failed';
        showAlert(msg, { title: 'Add credential failed' });
        return;
      }
      apiKeyInput.value = '';
      if (modelCustomInput) modelCustomInput.value = '';
      if (providerSelect) providerSelect.value = '';
      fillModelSelect();
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

  addFormRoot.querySelector('#credentials-provider-select')?.addEventListener('change', fillModelSelect);
  addFormRoot.querySelector('#credentials-model-select')?.addEventListener('change', () => toggleModelCustomVisibility());
  addFormRoot.querySelector('#credentials-model-custom')?.addEventListener('blur', () => {
    const modelCustomInput = addFormRoot.querySelector('#credentials-model-custom');
    const modelSel = addFormRoot.querySelector('#credentials-model-select');
    if (modelSel?.value === '__custom__' && (!modelCustomInput?.value || !modelCustomInput.value.trim())) {
      if (modelSel) modelSel.value = '';
      if (modelCustomInput) modelCustomInput.value = '';
      toggleModelCustomVisibility();
    }
  });

  fillProviderSelect();
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
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-run" id="settings-tab-run" data-tab="run">Prompt Runner</button>
                      <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="settings-panel-review" id="settings-tab-review" data-tab="review">Prompt Reviewer</button>
                    </div>
                  </div>
                  <div class="review-detail-tab-panels model-settings-tab-panels">
                    <div class="review-detail-tab-panel review-detail-tab-panel--active" id="settings-panel-credentials" role="tabpanel" aria-labelledby="settings-tab-credentials" data-panel="credentials">
                      <div class="defaults-page-scroll settings-credentials-tab-body">
                        <div id="model-settings-credentials-add" class="model-settings-credentials-add">
                          <div class="credentials-add-row">
                            <div class="credentials-add-field">
                              <label class="dataset-meta-label" for="credentials-provider-select">Provider</label>
                              <select id="credentials-provider-select" class="credentials-select dataset-meta-input" aria-label="Select provider">
                                <option value="">${selectPlaceholderLabel('Select provider')}</option>
                              </select>
                            </div>
                            <div class="credentials-add-field credentials-model-cell">
                              <label class="dataset-meta-label" for="credentials-model-select">Model type</label>
                              <div class="credentials-model-preset-wrap">
                                <select id="credentials-model-select" class="credentials-select dataset-meta-input" aria-label="Select model type">
                                  <option value="">${selectPlaceholderLabel('Select model type')}</option>
                                </select>
                              </div>
                              <div class="credentials-model-custom-wrap" id="credentials-model-custom-wrap">
                                <input type="text" id="credentials-model-custom" class="dataset-meta-input" placeholder="e.g. gpt-4o, claude-3-opus-20240229" autocomplete="off" aria-label="Custom model ID" />
                              </div>
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
                              <label class="dataset-meta-label" for="settings-run-concurrency">Concurrency (1–4)</label>
                              <input type="number" id="settings-run-concurrency" class="dataset-meta-input" min="1" max="4" value="1" aria-label="Run concurrency" />
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
                            <div class="defaults-field defaults-field--full">
                              <label class="dataset-meta-label" for="settings-default-review-assistant-credential">Assistant model (chat)</label>
                              <select id="settings-default-review-assistant-credential" class="credentials-select dataset-meta-input" aria-label="Model for Review assistant chat">
                                <option value="">${selectPlaceholderLabel('Same as Default model')}</option>
                              </select>
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-concurrency">Review concurrency (1–4)</label>
                              <input type="number" id="settings-review-concurrency" class="dataset-meta-input" min="1" max="4" value="1" aria-label="Review phase-1 concurrency" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-tokens">Max tokens (256–131072)</label>
                              <input type="number" id="settings-review-max-tokens" class="dataset-meta-input" min="256" max="131072" value="32768" aria-label="Review max tokens" />
                            </div>
                            <div class="defaults-field">
                              <label class="dataset-meta-label" for="settings-review-max-failed-rows">Max failed rows per Review (1–200)</label>
                              <input type="number" id="settings-review-max-failed-rows" class="dataset-meta-input" min="1" max="200" value="30" aria-label="Max failed rows analyzed per Review" />
                            </div>
                            <div class="defaults-field defaults-field--full">
                              <p class="dataset-meta-label" style="margin-bottom:0.35rem;font-weight:600;">Bayesian Finetune</p>
                            </div>
                            <div class="defaults-field defaults-field--review-finetune-input">
                              <label class="dataset-meta-label" for="settings-review-finetune-max-trials">Max trials (evaluation rounds, 4–200)</label>
                              <input type="number" id="settings-review-finetune-max-trials" class="dataset-meta-input" min="4" max="200" value="22" aria-label="Finetune max trials" />
                            </div>
                            <div class="defaults-field defaults-field--review-finetune-input">
                              <label class="dataset-meta-label" for="settings-review-finetune-num-candidates">Candidate paraphrases (4–18)</label>
                              <input type="number" id="settings-review-finetune-num-candidates" class="dataset-meta-input" min="4" max="18" value="10" aria-label="Finetune number of candidates" />
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
  const reviewAssistantCredSelect = overlay.querySelector('#settings-default-review-assistant-credential');
  const runConcurrencyInp = overlay.querySelector('#settings-run-concurrency');
  const runMaxTokensInp = overlay.querySelector('#settings-run-max-tokens');
  const reviewConcurrencyInp = overlay.querySelector('#settings-review-concurrency');
  const reviewMaxTokensInp = overlay.querySelector('#settings-review-max-tokens');
  const reviewMaxFailedRowsInp = overlay.querySelector('#settings-review-max-failed-rows');
  const runMaxRetriesInp = overlay.querySelector('#settings-run-max-retries');
  const reviewFinetuneMaxTrialsInp = overlay.querySelector('#settings-review-finetune-max-trials');
  const reviewFinetuneNumCandidatesInp = overlay.querySelector('#settings-review-finetune-num-candidates');

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
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.llm || c.id)}</option>`
    ).join('');
    const optNone = `<option value="">${selectPlaceholderLabel('None (select each time)')}</option>`;
    const optSame = `<option value="">${selectPlaceholderLabel('Same as Default model')}</option>`;
    runCredSelect.innerHTML = optNone + optHtml;
    reviewCredSelect.innerHTML = optNone + optHtml;
    reviewAssistantCredSelect.innerHTML = optSame + optHtml;
  }

  function applySettings(settings) {
    if (!settings) return;
    runCredSelect.value = settings.default_run_credential_id || '';
    reviewCredSelect.value = settings.default_review_credential_id || '';
    reviewAssistantCredSelect.value = settings.default_review_assistant_credential_id || '';
    runConcurrencyInp.value = String(settings.run_concurrency ?? MODEL_SETTINGS_DEFAULTS.run_concurrency);
    reviewConcurrencyInp.value = String(settings.review_concurrency ?? MODEL_SETTINGS_DEFAULTS.review_concurrency);
    runMaxTokensInp.value = String(settings.run_max_tokens ?? MODEL_SETTINGS_DEFAULTS.run_max_tokens);
    reviewMaxTokensInp.value = String(settings.review_max_tokens ?? MODEL_SETTINGS_DEFAULTS.review_max_tokens);
    reviewMaxFailedRowsInp.value = String(settings.review_max_failed_rows ?? MODEL_SETTINGS_DEFAULTS.review_max_failed_rows);
    runMaxRetriesInp.value = String(settings.run_max_retries ?? MODEL_SETTINGS_DEFAULTS.run_max_retries);
    reviewFinetuneMaxTrialsInp.value = String(
      settings.review_finetune_max_trials ?? MODEL_SETTINGS_DEFAULTS.review_finetune_max_trials,
    );
    reviewFinetuneNumCandidatesInp.value = String(
      settings.review_finetune_num_candidates ?? MODEL_SETTINGS_DEFAULTS.review_finetune_num_candidates,
    );
  }

  async function init() {
    const credRoot = overlay.querySelector('#model-settings-credentials-root');
    const addRoot = overlay.querySelector('#model-settings-credentials-add');
    await mountCredentialsTableHost(credRoot, {
      onCredentialsChange: async () => {
        const ids = {
          run: (runCredSelect.value || '').trim(),
          review: (reviewCredSelect.value || '').trim(),
          assistant: (reviewAssistantCredSelect.value || '').trim(),
        };
        const credentials = await loadCredentials();
        populateCredentialSelects(credentials);
        runCredSelect.value = ids.run;
        reviewCredSelect.value = ids.review;
        reviewAssistantCredSelect.value = ids.assistant;
      },
    });
    wireCredentialsAddForm(addRoot, credRoot);
    const [credentials, settings] = await Promise.all([loadCredentials(), loadSettings()]);
    populateCredentialSelects(credentials);
    applySettings(settings || MODEL_SETTINGS_DEFAULTS);
  }

  function getPatchFromForm() {
    const runConcurrency = Math.min(4, Math.max(1, parseInt(runConcurrencyInp.value, 10) || 1));
    const reviewConcurrency = Math.min(4, Math.max(1, parseInt(reviewConcurrencyInp.value, 10) || 1));
    const runMaxTokens = Math.min(131072, Math.max(256, parseInt(runMaxTokensInp.value, 10) || 8192));
    const reviewMaxTokens = Math.min(131072, Math.max(256, parseInt(reviewMaxTokensInp.value, 10) || 32768));
    const reviewMaxFailedRows = Math.min(200, Math.max(1, parseInt(reviewMaxFailedRowsInp.value, 10) || 30));
    const runMaxRetries = Math.min(5, Math.max(0, parseInt(runMaxRetriesInp.value, 10) || 2));
    const reviewFinetuneMaxTrials = Math.min(200, Math.max(4, parseInt(reviewFinetuneMaxTrialsInp.value, 10) || 22));
    const reviewFinetuneNumCandidates = Math.min(18, Math.max(4, parseInt(reviewFinetuneNumCandidatesInp.value, 10) || 10));
    return {
      default_run_credential_id: (runCredSelect.value || '').trim() || '',
      default_review_credential_id: (reviewCredSelect.value || '').trim() || '',
      default_review_assistant_credential_id: (reviewAssistantCredSelect.value || '').trim() || '',
      run_concurrency: runConcurrency,
      review_concurrency: reviewConcurrency,
      run_max_tokens: runMaxTokens,
      review_max_tokens: reviewMaxTokens,
      review_max_failed_rows: reviewMaxFailedRows,
      run_max_retries: runMaxRetries,
      review_finetune_max_trials: reviewFinetuneMaxTrials,
      review_finetune_num_candidates: reviewFinetuneNumCandidates,
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
