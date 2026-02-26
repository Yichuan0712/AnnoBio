/**
 * "My credentials" modal: table of LLM credentials, add form.
 * Uses backend API: GET/POST/DELETE /api/credentials.
 */

import { showAlert, showConfirm } from './alertModal.js';

const API_BASE = 'http://localhost:8000';

function getTbody(overlay) {
  return overlay.querySelector('.credentials-table tbody');
}

function renderCredentialsTable(overlay, list) {
  const tbody = getTbody(overlay);
  if (!tbody) return;
  const providerName = (id) => (overlay._providersMap && overlay._providersMap[id]) || id || '—';
  const modelLabel = (v) => (overlay._modelsMap && overlay._modelsMap[v] && overlay._modelsMap[v].name) || v || '—';
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="5">No credentials added yet.</td></tr>';
    return;
  }
  const escapeHtml = (s) => {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
  };
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
        <button type="button" class="btn btn-secondary credentials-test-btn" data-id="${c.id}" aria-label="Test">Test</button>
        <button type="button" class="btn btn-secondary credentials-delete-btn" data-id="${c.id}" aria-label="Delete">Delete</button>
      </td>
    </tr>
  `).join('');
}

async function fetchCredentials() {
  const res = await fetch(`${API_BASE}/api/credentials`);
  if (!res.ok) throw new Error('Failed to load credentials');
  return res.json();
}

async function loadAndRender(overlay) {
  try {
    const list = await fetchCredentials();
    renderCredentialsTable(overlay, list);
    bindNameCellClick(overlay);
    bindKeyCellClick(overlay);
    bindTestButtons(overlay);
    bindDeleteButtons(overlay);
  } catch (e) {
    console.error('Load credentials:', e);
    const tbody = getTbody(overlay);
    if (tbody) tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="5">Unable to load (is the backend running?).</td></tr>';
  }
}

function openNameEditInCell(id, nameCell, currentName) {
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

function bindNameCellClick(overlay) {
  overlay.querySelectorAll('.credentials-name-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const row = cell.closest('tr');
      const id = row?.getAttribute('data-credential-id');
      if (!id) return;
      const currentName = (cell.textContent || '').trim();
      openNameEditInCell(id, cell, currentName);
    });
  });
}

const MASKED_PLACEHOLDER = '••••••••';

function openKeyViewInCell(id, keyCell) {
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

function bindKeyCellClick(overlay) {
  overlay.querySelectorAll('.credentials-key-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const row = cell.closest('tr');
      const id = row?.getAttribute('data-credential-id');
      if (!id) return;
      openKeyViewInCell(id, cell);
    });
  });
}

function bindTestButtons(overlay) {
  overlay.querySelectorAll('.credentials-test-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  overlay.querySelectorAll('.credentials-test-btn').forEach((btn) => {
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

function bindDeleteButtons(overlay) {
  overlay.querySelectorAll('.credentials-delete-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  overlay.querySelectorAll('.credentials-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      const ok = await showConfirm('Delete this credential?', { title: 'Delete credential', confirmText: 'Delete' });
      if (!ok) return;
      try {
        const res = await fetch(`${API_BASE}/api/credentials/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadAndRender(overlay);
      } catch (e) {
        console.error('Delete credential:', e);
      }
    });
  });
}

export function openCredentialsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'my-credentials-title');
  overlay.innerHTML = `
    <style>
      .modal-panel--credentials {
        width: 520px;
        max-width: 92vw;
      }
      .modal-panel--credentials .credentials-add-card {
        margin-top: 1rem;
      }
      .modal-panel--credentials .credentials-add-row {
        display: grid;
        grid-template-columns: 145px 165px 1fr auto;
        row-gap: 0.75rem;
        column-gap: 1.5rem;
        align-items: end;
      }
      .modal-panel--credentials .credentials-add-field {
        min-width: 0;
        overflow: hidden;
      }
      .modal-panel--credentials .credentials-add-field.credentials-add-field--btn {
        justify-self: end;
        overflow: visible;
      }
      .modal-panel--credentials .credentials-add-card .credentials-select,
      .modal-panel--credentials .credentials-add-card .dataset-meta-input,
      .modal-panel--credentials .credentials-add-card .credentials-add-btn {
        height: 40px;
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        border-radius: 6px;
      }
      .modal-panel--credentials .credentials-add-card .credentials-add-field--btn .credentials-add-btn {
        width: auto;
      }
      .modal-panel--credentials .credentials-add-card .credentials-add-btn {
        line-height: 1;
      }
      .modal-panel--credentials .credentials-model-cell {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .modal-panel--credentials .credentials-model-custom-wrap {
        display: none;
      }
      .modal-panel--credentials .credentials-model-custom-wrap.is-visible {
        display: block;
      }
      .modal-panel--credentials .credentials-model-preset-wrap.is-hidden {
        display: none;
      }
      .modal-panel--credentials .credentials-name-cell,
      .modal-panel--credentials .credentials-key-cell {
        cursor: pointer;
        vertical-align: middle;
        position: relative;
      }
      .modal-panel--credentials .credentials-name-cell:has(.credentials-cell-edit-wrap),
      .modal-panel--credentials .credentials-key-cell:has(.credentials-cell-edit-wrap) {
        min-height: 2.5em;
      }
      .modal-panel--credentials .credentials-table {
        table-layout: fixed;
      }
      .modal-panel--credentials .credentials-table th:nth-child(1),
      .modal-panel--credentials .credentials-table td:nth-child(1) { width: 120px; max-width: 120px; overflow: hidden; }
      .modal-panel--credentials .credentials-table th:nth-child(4),
      .modal-panel--credentials .credentials-table td:nth-child(4) { width: 160px; max-width: 160px; overflow: hidden; }
      .modal-panel--credentials .credentials-cell-edit-wrap {
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        z-index: 5;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--control-radius, 4px);
        padding: 2px 6px;
      }
      .modal-panel--credentials .credentials-cell-edit-wrap input {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        padding: 2px 0;
        background: transparent;
        color: var(--text);
        border: none;
        border-radius: 0;
        font: inherit;
        outline: none;
      }
      .modal-panel--credentials .credentials-cell-key-wrap input {
        font-size: 0.9em;
        overflow-x: auto;
      }
      .modal-panel--credentials .credentials-actions-cell .btn {
        min-width: 72px;
      }
    </style>
    <div class="modal-panel modal-panel--credentials">
      <div class="modal-header">
        <h2 id="my-credentials-title" class="modal-title">My credentials</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body modal-body--credentials">
        <div class="credentials-table-wrap">
          <h3 class="credentials-section-title">Models you can use</h3>
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
        <div class="credentials-add credentials-add-card">
          <p class="credentials-section-title credentials-add-title">Add new credential</p>
          <div class="credentials-add-row">
            <div class="credentials-add-field">
              <label class="dataset-meta-label" for="credentials-provider-select">Provider</label>
              <select id="credentials-provider-select" class="credentials-select" aria-label="Select provider">
                <option value="">— Select provider —</option>
              </select>
            </div>
            <div class="credentials-add-field credentials-model-cell">
              <label class="dataset-meta-label" for="credentials-model-select">Model type</label>
              <div class="credentials-model-preset-wrap">
                <select id="credentials-model-select" class="credentials-select" aria-label="Select model type">
                  <option value="">— Select model type —</option>
                </select>
              </div>
              <div class="credentials-model-custom-wrap" id="credentials-model-custom-wrap">
                <input type="text" id="credentials-model-custom" class="dataset-meta-input" placeholder="e.g. gpt-4o, claude-3-opus-20240229" autocomplete="off" aria-label="Custom model ID" />
              </div>
            </div>
            <div class="credentials-add-field credentials-add-field--grow">
              <label class="dataset-meta-label" for="credentials-api-key">API key</label>
              <input type="text" id="credentials-api-key" class="dataset-meta-input credentials-api-key-input" placeholder="Paste your API key" autocomplete="off" />
            </div>
            <div class="credentials-add-field credentials-add-field--btn">
              <label class="dataset-meta-label" aria-hidden="true">&nbsp;</label>
              <button type="button" class="btn btn-secondary credentials-add-btn">Add</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };
  overlay.querySelector('.modal-close').addEventListener('click', close);

  overlay.querySelector('.credentials-add-btn').addEventListener('click', async () => {
    const providerSelect = overlay.querySelector('#credentials-provider-select');
    const modelSelect = overlay.querySelector('#credentials-model-select');
    const modelCustomInput = overlay.querySelector('#credentials-model-custom');
    const apiKeyInput = overlay.querySelector('#credentials-api-key');
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
      await loadAndRender(overlay);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      showAlert(msg, { title: 'Add credential failed' });
      console.error('Add credential:', e);
    }
  });

  function fillProviderSelect() {
    const sel = overlay.querySelector('#credentials-provider-select');
    if (!sel || !overlay._providers) return;
    const placeholder = '<option value="">— Select provider —</option>';
    const options = overlay._providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.innerHTML = placeholder + options;
    fillModelSelect();
  }

  function fillModelSelect() {
    const providerSel = overlay.querySelector('#credentials-provider-select');
    const modelSel = overlay.querySelector('#credentials-model-select');
    if (!modelSel || !overlay._models) return;
    const providerId = (providerSel && providerSel.value) || '';
    const modelsForProvider = providerId ? overlay._models.filter((m) => m.provider === providerId) : [];
    const customOption = providerId ? '<option value="__custom__">— Custom —</option>' : '';
    modelSel.innerHTML = '<option value="">— Select model type —</option>' + modelsForProvider.map((m) => `<option value="${m.id}">${m.name}</option>`).join('') + customOption;
    toggleModelCustomVisibility(overlay);
  }

  function toggleModelCustomVisibility(overlay) {
    const modelSel = overlay.querySelector('#credentials-model-select');
    const presetWrap = overlay.querySelector('.credentials-model-preset-wrap');
    const customWrap = overlay.querySelector('#credentials-model-custom-wrap');
    const isCustom = modelSel?.value === '__custom__';
    if (presetWrap) presetWrap.classList.toggle('is-hidden', isCustom);
    if (customWrap) customWrap.classList.toggle('is-visible', isCustom);
  }

  overlay.querySelector('#credentials-provider-select')?.addEventListener('change', fillModelSelect);
  overlay.querySelector('#credentials-model-select')?.addEventListener('change', () => toggleModelCustomVisibility(overlay));
  overlay.querySelector('#credentials-model-custom')?.addEventListener('blur', () => {
    const modelCustomInput = overlay.querySelector('#credentials-model-custom');
    const modelSel = overlay.querySelector('#credentials-model-select');
    if (modelSel?.value === '__custom__' && (!modelCustomInput?.value || !modelCustomInput.value.trim())) {
      if (modelSel) modelSel.value = '';
      if (modelCustomInput) modelCustomInput.value = '';
      toggleModelCustomVisibility(overlay);
    }
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  // 与 backend main.py 的 PROVIDERS / MODELS 保持一致，不依赖接口返回的列表，保证下拉始终有全部选项
  const allProviders = [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'google', name: 'Google' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'mistral', name: 'Mistral' },
    { id: 'bedrock', name: 'Amazon Bedrock' },
  ];
  const allModels = [
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
  (async () => {
    overlay._providers = allProviders;
    overlay._models = allModels;
    overlay._providersMap = Object.fromEntries(allProviders.map((p) => [p.id, p.name]));
    overlay._modelsMap = Object.fromEntries(allModels.map((m) => [m.id, m]));
    fillProviderSelect();
    await loadAndRender(overlay);
  })();
}
