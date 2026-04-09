/**
 * Model settings modal: default models, concurrency, max tokens.
 * Uses backend API: GET /api/settings, PATCH /api/settings.
 * Paged layout like Create prompt / Create dataset (data-defaults-page + defaults-page-label + prompt-actions).
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
  overlay.setAttribute('aria-labelledby', 'model-settings-title');
  overlay.innerHTML = `
    <style>
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
      .modal-panel--defaults .credentials-add.defaults-card .credentials-select,
      .modal-panel--defaults .credentials-add.defaults-card .dataset-meta-input {
        height: 40px;
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        border-radius: 6px;
      }
    </style>
    <div class="modal-panel modal-panel--defaults" data-defaults-page="1">
      <div class="modal-header">
        <h2 id="model-settings-title" class="modal-title">Model settings</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--defaults">
        <div class="defaults-add-main">
          <div class="defaults-add-page defaults-add-page-1">
            <p class="defaults-page-label">Page 1 of 2 — Prompt Runner</p>
            <div class="defaults-page-scroll">
              <div class="credentials-add defaults-card">
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
                    <label class="dataset-meta-label" for="settings-run-max-retries">Max retries on error (0–5)</label>
                    <input type="number" id="settings-run-max-retries" class="dataset-meta-input" min="0" max="5" value="2" aria-label="Run max retries" />
                  </div>
                </div>
              </div>
            </div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary defaults-btn-next">Next</button>
            </div>
          </div>
          <div class="defaults-add-page defaults-add-page-2">
            <p class="defaults-page-label">Page 2 of 2 — Prompt Reviewer</p>
            <div class="defaults-page-scroll">
              <div class="credentials-add defaults-card">
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
                </div>
              </div>
            </div>
            <div class="prompt-actions">
              <button type="button" class="btn btn-secondary defaults-btn-back">Back</button>
              <button type="button" class="btn btn-primary defaults-btn-done">Done</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const panel = overlay.querySelector('.modal-panel--defaults');
  const runCredSelect = overlay.querySelector('#settings-default-run-credential');
  const reviewCredSelect = overlay.querySelector('#settings-default-review-credential');
  const reviewAssistantCredSelect = overlay.querySelector('#settings-default-review-assistant-credential');
  const runConcurrencyInp = overlay.querySelector('#settings-run-concurrency');
  const runMaxTokensInp = overlay.querySelector('#settings-run-max-tokens');
  const reviewConcurrencyInp = overlay.querySelector('#settings-review-concurrency');
  const reviewMaxTokensInp = overlay.querySelector('#settings-review-max-tokens');
  const reviewMaxFailedRowsInp = overlay.querySelector('#settings-review-max-failed-rows');
  const runMaxRetriesInp = overlay.querySelector('#settings-run-max-retries');

  function goToDefaultsPage(page) {
    panel.setAttribute('data-defaults-page', String(page));
  }

  overlay.querySelector('.defaults-btn-next')?.addEventListener('click', () => goToDefaultsPage(2));
  overlay.querySelector('.defaults-btn-back')?.addEventListener('click', () => goToDefaultsPage(1));

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
    reviewMaxFailedRowsInp.value = String(settings.review_max_failed_rows ?? 30);
    runMaxRetriesInp.value = String(settings.run_max_retries ?? 2);
  }

  async function init() {
    const [credentials, settings] = await Promise.all([loadCredentials(), loadSettings()]);
    populateCredentialSelects(credentials);
    applySettings(settings);
  }

  function getPatchFromForm() {
    const runConcurrency = Math.min(4, Math.max(1, parseInt(runConcurrencyInp.value, 10) || 1));
    const reviewConcurrency = Math.min(4, Math.max(1, parseInt(reviewConcurrencyInp.value, 10) || 1));
    const runMaxTokens = Math.min(131072, Math.max(256, parseInt(runMaxTokensInp.value, 10) || 8192));
    const reviewMaxTokens = Math.min(131072, Math.max(256, parseInt(reviewMaxTokensInp.value, 10) || 32768));
    const reviewMaxFailedRows = Math.min(200, Math.max(1, parseInt(reviewMaxFailedRowsInp.value, 10) || 30));
    const runMaxRetries = Math.min(5, Math.max(0, parseInt(runMaxRetriesInp.value, 10) ?? 2));
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
  overlay.querySelector('.defaults-btn-done')?.addEventListener('click', closeModal);

  [runCredSelect, reviewCredSelect, reviewAssistantCredSelect].forEach((el) => el.addEventListener('change', scheduleSave));
  [runConcurrencyInp, reviewConcurrencyInp, runMaxTokensInp, reviewMaxTokensInp, reviewMaxFailedRowsInp, runMaxRetriesInp].forEach((el) => {
    el.addEventListener('change', scheduleSave);
    el.addEventListener('input', scheduleSave);
  });

  init();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
