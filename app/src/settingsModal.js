/**
 * Model defaults modal: default models, concurrency, max tokens.
 * Uses backend API: GET /api/settings, PATCH /api/settings.
 */

import { showAlert } from './alertModal.js';

const API_BASE = 'http://localhost:8000';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function openSettingsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'defaults-title');
  overlay.innerHTML = `
    <style>
      .modal-panel--defaults {
        width: 520px;
        max-width: 92vw;
      }
      .modal-panel--defaults .defaults-card:first-child {
        margin-top: 0.5rem;
      }
      .modal-panel--defaults .defaults-divider {
        margin: 1.5rem -20px 0 -20px;
        height: 1px;
        background: var(--border);
        width: calc(100% + 40px);
      }
      .modal-panel--defaults .defaults-card:last-child {
        margin-top: 1.5rem;
      }
      .modal-panel--defaults .defaults-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        row-gap: 0.75rem;
        column-gap: 1.5rem;
        align-items: end;
      }
      .modal-panel--defaults .defaults-field--full {
        grid-column: 1 / -1;
      }
      .modal-panel--defaults .defaults-field {
        min-width: 0;
        overflow: hidden;
      }
      .modal-panel--defaults .defaults-card .credentials-select,
      .modal-panel--defaults .defaults-card .dataset-meta-input {
        height: 40px;
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        border-radius: 6px;
      }
      .modal-panel--defaults .defaults-card .btn {
        min-height: 40px;
        padding: 0 1rem;
      }
    </style>
    <div class="modal-panel modal-panel--defaults">
      <div class="modal-header">
        <h2 id="defaults-title" class="modal-title">Model defaults</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--defaults">
        <div class="credentials-add defaults-card">
          <p class="credentials-section-title credentials-add-title">Prompt Runner</p>
          <div class="defaults-row">
            <div class="defaults-field defaults-field--full">
              <label class="dataset-meta-label" for="settings-default-run-credential">Default model</label>
              <select id="settings-default-run-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Run">
                <option value="">— None (select each time) —</option>
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
              <label class="dataset-meta-label" for="settings-run-max-retries">Max retries on error (0–10)</label>
              <input type="number" id="settings-run-max-retries" class="dataset-meta-input" min="0" max="10" value="2" aria-label="Run max retries" />
            </div>
          </div>
        </div>
        <div class="defaults-divider" aria-hidden="true"></div>
        <div class="credentials-add defaults-card">
          <p class="credentials-section-title credentials-add-title">Prompt Reviewer</p>
          <div class="defaults-row">
            <div class="defaults-field defaults-field--full">
              <label class="dataset-meta-label" for="settings-default-review-credential">Default model</label>
              <select id="settings-default-review-credential" class="credentials-select dataset-meta-input" aria-label="Default model for Review">
                <option value="">— None (select each time) —</option>
              </select>
            </div>
            <div class="defaults-field defaults-field--full">
              <label class="dataset-meta-label" for="settings-default-review-assistant-credential">Assistant model (chat)</label>
              <select id="settings-default-review-assistant-credential" class="credentials-select dataset-meta-input" aria-label="Model for Review assistant chat">
                <option value="">— Same as Default model —</option>
              </select>
            </div>
            <div class="defaults-field">
              <label class="dataset-meta-label" for="settings-review-concurrency">Concurrency (1–4)</label>
              <input type="number" id="settings-review-concurrency" class="dataset-meta-input" min="1" max="4" value="1" aria-label="Review concurrency" />
            </div>
            <div class="defaults-field">
              <label class="dataset-meta-label" for="settings-review-max-tokens">Max tokens (256–131072)</label>
              <input type="number" id="settings-review-max-tokens" class="dataset-meta-input" min="256" max="131072" value="32768" aria-label="Review max tokens" />
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
  const reviewConcurrencyInp = overlay.querySelector('#settings-review-concurrency');
  const runMaxTokensInp = overlay.querySelector('#settings-run-max-tokens');
  const reviewMaxTokensInp = overlay.querySelector('#settings-review-max-tokens');
  const runMaxRetriesInp = overlay.querySelector('#settings-run-max-retries');

  async function loadCredentials() {
    try {
      const res = await fetch(`${API_BASE}/api/credentials`);
      if (!res.ok) return [];
      const list = await res.json();
      return list;
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
    runCredSelect.innerHTML = '<option value="">— None (select each time) —</option>' + optHtml;
    reviewCredSelect.innerHTML = '<option value="">— None (select each time) —</option>' + optHtml;
    reviewAssistantCredSelect.innerHTML = '<option value="">— Same as Default model —</option>' + optHtml;
  }

  function applySettings(settings) {
    if (!settings) return;
    if (settings.default_run_credential_id) runCredSelect.value = settings.default_run_credential_id;
    if (settings.default_review_credential_id) reviewCredSelect.value = settings.default_review_credential_id;
    if (settings.default_review_assistant_credential_id) reviewAssistantCredSelect.value = settings.default_review_assistant_credential_id;
    runConcurrencyInp.value = String(settings.run_concurrency ?? 1);
    reviewConcurrencyInp.value = String(settings.review_concurrency ?? 1);
    runMaxTokensInp.value = String(settings.run_max_tokens ?? 8192);
    reviewMaxTokensInp.value = String(settings.review_max_tokens ?? 32768);
    runMaxRetriesInp.value = String(settings.run_max_retries ?? 2);
  }

  async function init() {
    const [credentials, settings] = await Promise.all([loadCredentials(), loadSettings()]);
    populateCredentialSelects(credentials);
    applySettings(settings);
  }

  const DEFAULT_VALUES = {
    default_run_credential_id: '',
    default_review_credential_id: '',
    default_review_assistant_credential_id: '',
    run_concurrency: 1,
    review_concurrency: 1,
    run_max_tokens: 8192,
    review_max_tokens: 32768,
    run_max_retries: 2,
  };

  function getPatchFromForm() {
    const runConcurrency = Math.min(4, Math.max(1, parseInt(runConcurrencyInp.value, 10) || 1));
    const reviewConcurrency = Math.min(4, Math.max(1, parseInt(reviewConcurrencyInp.value, 10) || 1));
    const runMaxTokens = Math.min(131072, Math.max(256, parseInt(runMaxTokensInp.value, 10) || 8192));
    const reviewMaxTokens = Math.min(131072, Math.max(256, parseInt(reviewMaxTokensInp.value, 10) || 32768));
    const runMaxRetries = Math.min(10, Math.max(0, parseInt(runMaxRetriesInp.value, 10) ?? 2));
    return {
      default_run_credential_id: (runCredSelect.value || '').trim() || '',
      default_review_credential_id: (reviewCredSelect.value || '').trim() || '',
      default_review_assistant_credential_id: (reviewAssistantCredSelect.value || '').trim() || '',
      run_concurrency: runConcurrency,
      review_concurrency: reviewConcurrency,
      run_max_tokens: runMaxTokens,
      review_max_tokens: reviewMaxTokens,
      run_max_retries: runMaxRetries,
    };
  }

  let saveTimeout = null;
  function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => doSave(), 300);
  }

  async function doSave() {
    saveTimeout = null;
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
    } catch (e) {
      showAlert(e.message || 'Failed to save', { title: 'Error' });
    }
  }

  function closeModal() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', closeModal);

  [runCredSelect, reviewCredSelect, reviewAssistantCredSelect].forEach((el) => el.addEventListener('change', scheduleSave));
  [runConcurrencyInp, reviewConcurrencyInp, runMaxTokensInp, reviewMaxTokensInp, runMaxRetriesInp].forEach((el) => {
    el.addEventListener('change', scheduleSave);
    el.addEventListener('input', scheduleSave);
  });

  init();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
