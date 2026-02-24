/**
 * "My credentials" modal: table of LLM credentials, add form.
 * Uses backend API: GET/POST/DELETE /api/credentials.
 */

import { showAlert } from './alertModal.js';

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
        <button type="button" class="btn btn-secondary credentials-rename-btn" data-id="${c.id}" aria-label="Rename">Rename</button>
        <button type="button" class="btn btn-secondary credentials-show-key-btn" data-id="${c.id}" aria-label="Show key">Show</button>
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
    bindRenameButtons(overlay);
    bindShowKeyButtons(overlay);
    bindTestButtons(overlay);
    bindDeleteButtons(overlay);
  } catch (e) {
    console.error('Load credentials:', e);
    const tbody = getTbody(overlay);
    if (tbody) tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="5">Unable to load (is the backend running?).</td></tr>';
  }
}

function bindRenameButtons(overlay) {
  overlay.querySelectorAll('.credentials-rename-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  overlay.querySelectorAll('.credentials-rename-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const row = btn.closest('tr');
      const nameCell = row?.querySelector('.credentials-name-cell');
      if (!id || !nameCell) return;
      if (nameCell.querySelector('.credentials-rename-inline')) return;
      const currentName = (nameCell.textContent || '').trim();
      const wrap = document.createElement('div');
      wrap.className = 'credentials-rename-inline';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dataset-meta-input credentials-rename-input';
      input.value = currentName;
      input.setAttribute('aria-label', 'New name');
      const doSave = async () => {
        const trimmed = input.value.trim();
        if (!trimmed) {
          nameCell.textContent = currentName;
          wrap.remove();
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/api/credentials/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            nameCell.textContent = trimmed;
            wrap.remove();
          } else {
            nameCell.textContent = currentName;
            wrap.remove();
            const hint = row?.querySelector('.credentials-test-hint');
            if (hint) {
              hint.textContent = typeof data.detail === 'string' ? data.detail : 'Rename failed';
              hint.classList.remove('credentials-test-hint--success');
              hint.classList.add('credentials-test-hint--error');
              setTimeout(() => {
                hint.textContent = '';
                hint.classList.remove('credentials-test-hint--error');
              }, 4000);
            }
          }
        } catch (e) {
          console.error('Rename credential:', e);
          nameCell.textContent = currentName;
          wrap.remove();
        }
      };
      const doCancel = () => {
        nameCell.textContent = currentName;
        wrap.remove();
      };
      input.addEventListener('blur', doSave);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
      });
      wrap.appendChild(input);
      nameCell.textContent = '';
      nameCell.appendChild(wrap);
      input.focus();
      input.select();
    });
  });
}

function bindShowKeyButtons(overlay) {
  const maskedPlaceholder = '••••••••';
  overlay.querySelectorAll('.credentials-show-key-btn').forEach((btn) => {
    btn.replaceWith(btn.cloneNode(true));
  });
  overlay.querySelectorAll('.credentials-show-key-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const row = btn.closest('tr');
      const code = row?.querySelector('.credentials-key-value');
      if (!id || !code) return;
      const visible = code.getAttribute('data-visible') === 'true';
      if (visible) {
        code.textContent = maskedPlaceholder;
        code.removeAttribute('data-visible');
        code.removeAttribute('data-full-key');
        btn.textContent = 'Show';
        btn.setAttribute('aria-label', 'Show key');
        return;
      }
      const cached = code.getAttribute('data-full-key');
      if (cached !== null) {
        code.textContent = cached;
        code.setAttribute('data-visible', 'true');
        btn.textContent = 'Hide';
        btn.setAttribute('aria-label', 'Hide key');
        return;
      }
      code.textContent = '…';
      try {
        const res = await fetch(`${API_BASE}/api/credentials/${id}`);
        if (!res.ok) throw new Error('Failed to load key');
        const data = await res.json();
        const fullKey = data.api_key ?? '';
        code.textContent = fullKey;
        code.setAttribute('data-full-key', fullKey);
        code.setAttribute('data-visible', 'true');
        btn.textContent = 'Hide';
        btn.setAttribute('aria-label', 'Hide key');
      } catch (e) {
        console.error('Load full key:', e);
        code.textContent = maskedPlaceholder;
      }
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
      btn.textContent = 'Testing...';
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
      .modal-panel--credentials .credentials-add-card .credentials-add-btn,
      .modal-panel--credentials .credentials-add-card .credentials-model-back-preset {
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
      .modal-panel--credentials .credentials-add-card .credentials-model-back-preset {
        width: 40px;
        min-width: 40px;
        padding: 0;
        font-size: 1.1rem;
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
      .modal-panel--credentials .credentials-model-custom-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      .modal-panel--credentials .credentials-model-custom-row input {
        flex: 1;
        min-width: 0;
      }
      .modal-panel--credentials .credentials-model-back-preset {
        flex-shrink: 0;
      }
      .modal-panel--credentials .credentials-model-preset-wrap.is-hidden {
        display: none;
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
                  <th>Model</th>
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
              <label class="dataset-meta-label" for="credentials-model-select">Model</label>
              <div class="credentials-model-preset-wrap">
                <select id="credentials-model-select" class="credentials-select" aria-label="Select model">
                  <option value="">— Select model —</option>
                </select>
              </div>
              <div class="credentials-model-custom-wrap" id="credentials-model-custom-wrap">
                <div class="credentials-model-custom-row">
                  <input type="text" id="credentials-model-custom" class="dataset-meta-input" placeholder="e.g. gpt-4o, claude-3-opus-20240229" autocomplete="off" aria-label="Custom model ID" />
                  <button type="button" class="btn btn-secondary credentials-model-back-preset" aria-label="Back to preset" title="Back to preset">×</button>
                </div>
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
      console.warn('Please select a model or enter a custom model id');
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
    modelSel.innerHTML = '<option value="">— Select model —</option>' + modelsForProvider.map((m) => `<option value="${m.id}">${m.name}</option>`).join('') + customOption;
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
  overlay.querySelector('.credentials-model-back-preset')?.addEventListener('click', () => {
    const modelSel = overlay.querySelector('#credentials-model-select');
    const modelCustomInput = overlay.querySelector('#credentials-model-custom');
    if (modelSel) modelSel.value = '';
    if (modelCustomInput) modelCustomInput.value = '';
    toggleModelCustomVisibility(overlay);
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  // 与 backend main.py 的 PROVIDERS / MODELS 保持一致，不依赖接口返回的列表，保证下拉始终有全部选项
  const allProviders = [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'google', name: 'Google' },
  ];
  const allModels = [
    { id: 'gpt-5', name: 'gpt-5', provider: 'openai' },
    { id: 'gpt-5-mini', name: 'gpt-5-mini', provider: 'openai' },
    { id: 'gpt-5-nano', name: 'gpt-5-nano', provider: 'openai' },
    { id: 'claude-3-5-sonnet', name: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
    { id: 'claude-3-5-haiku', name: 'claude-3-5-haiku-20241022', provider: 'anthropic' },
    { id: 'claude-3-opus', name: 'claude-3-opus-20240229', provider: 'anthropic' },
    { id: 'claude-3-sonnet', name: 'claude-3-sonnet-20240229', provider: 'anthropic' },
    { id: 'claude-3-haiku', name: 'claude-3-haiku-20240307', provider: 'anthropic' },
    { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', provider: 'google' },
    { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash', provider: 'google' },
    { id: 'gemini-2.5-flash-lite', name: 'gemini-2.5-flash-lite', provider: 'google' },
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
