/**
 * "My credentials" modal: table of LLM credentials, add form.
 * Uses backend API: GET/POST/DELETE /api/credentials.
 */

const API_BASE = 'http://localhost:8000';

function getTbody(overlay) {
  return overlay.querySelector('.credentials-table tbody');
}

function renderCredentialsTable(overlay, list) {
  const tbody = getTbody(overlay);
  if (!tbody) return;
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="4">No credentials added yet.</td></tr>';
    return;
  }
  const modelLabel = (v) => ({ 'gpt-5': 'gpt-5', 'gpt-5-mini': 'gpt-5-mini', 'gpt-5-nano': 'gpt-5-nano' }[v] || v);
  const escapeHtml = (s) => {
    const div = document.createElement('div');
    div.textContent = s ?? '';
    return div.innerHTML;
  };
  const maskedPlaceholder = '••••••••';
  tbody.innerHTML = list.map((c) => `
    <tr data-credential-id="${c.id}">
      <td class="credentials-name-cell">${escapeHtml(c.name || 'Unnamed')}</td>
      <td>${modelLabel(c.llm)}</td>
      <td class="credentials-key-cell">
        <code class="credentials-key-value">${maskedPlaceholder}</code>
      </td>
      <td class="credentials-actions-cell">
        <button type="button" class="btn btn-secondary credentials-rename-btn" data-id="${c.id}" aria-label="Rename">Rename</button>
        <button type="button" class="btn btn-secondary credentials-show-key-btn" data-id="${c.id}" aria-label="Show key">Show</button>
        <button type="button" class="btn btn-secondary credentials-test-btn" data-id="${c.id}" aria-label="Test">Test</button>
        <button type="button" class="btn btn-secondary credentials-delete-btn" data-id="${c.id}" aria-label="Delete">Delete</button>
        <span class="credentials-test-hint" aria-live="polite"></span>
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
    if (tbody) tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="4">Unable to load (is the backend running?).</td></tr>';
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
      const actionsCell = btn.closest('.credentials-actions-cell');
      const hint = actionsCell?.querySelector('.credentials-test-hint');
      try {
        const res = await fetch(`${API_BASE}/api/credentials/${id}/test`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          btn.textContent = origText;
          btn.disabled = false;
          if (hint) {
            hint.textContent = 'API key valid';
            hint.classList.remove('credentials-test-hint--error');
            hint.classList.add('credentials-test-hint--success');
            setTimeout(() => {
              hint.textContent = '';
              hint.classList.remove('credentials-test-hint--success');
            }, 4000);
          }
        } else {
          btn.textContent = origText;
          btn.disabled = false;
          if (hint) {
            hint.textContent = typeof data.detail === 'string' ? data.detail : 'Test failed';
            hint.classList.remove('credentials-test-hint--success');
            hint.classList.add('credentials-test-hint--error');
            setTimeout(() => {
              hint.textContent = '';
              hint.classList.remove('credentials-test-hint--error');
            }, 4000);
          }
          console.warn('Test failed:', data.detail || res.statusText);
        }
      } catch (e) {
        btn.textContent = origText;
        btn.disabled = false;
        if (hint) {
          hint.textContent = (e && e.message) || 'Test failed';
          hint.classList.remove('credentials-test-hint--success');
          hint.classList.add('credentials-test-hint--error');
          setTimeout(() => {
            hint.textContent = '';
            hint.classList.remove('credentials-test-hint--error');
          }, 4000);
        }
        console.error('Test credential:', e);
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
                  <th>Model</th>
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
        <div class="credentials-add">
          <h3 class="credentials-section-title">Create credential</h3>
          <div class="credentials-add-row">
            <div class="credentials-add-field">
              <label class="dataset-meta-label" for="credentials-model-select">Model</label>
              <select id="credentials-model-select" class="credentials-select" aria-label="Select model">
                <option value="">Select a model...</option>
                <option value="gpt-5">gpt-5</option>
                <option value="gpt-5-mini">gpt-5-mini</option>
                <option value="gpt-5-nano">gpt-5-nano</option>
              </select>
            </div>
            <div class="credentials-add-field credentials-add-field--grow">
              <label class="dataset-meta-label" for="credentials-api-key">API key</label>
              <div class="credentials-api-key-wrap">
                <input type="password" id="credentials-api-key" class="dataset-meta-input credentials-api-key-input" placeholder="Enter your API key" autocomplete="off" />
                <button type="button" class="credentials-api-key-toggle" aria-label="Show API key" title="Show API key">Show</button>
              </div>
            </div>
            <div class="credentials-add-field credentials-add-field--btn">
              <label class="dataset-meta-label" aria-hidden="true">&nbsp;</label>
              <button type="button" class="btn btn-secondary credentials-add-btn">Create and add to table</button>
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

  /* Toggle API key visibility */
  overlay.querySelector('.credentials-api-key-toggle').addEventListener('click', () => {
    const input = overlay.querySelector('#credentials-api-key');
    const btn = overlay.querySelector('.credentials-api-key-toggle');
    if (!input || !btn) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', isPassword ? 'Hide API key' : 'Show API key');
    btn.setAttribute('title', isPassword ? 'Hide API key' : 'Show API key');
  });

  overlay.querySelector('.credentials-add-btn').addEventListener('click', async () => {
    const modelSelect = overlay.querySelector('#credentials-model-select');
    const apiKeyInput = overlay.querySelector('#credentials-api-key');
    const llm = (modelSelect?.value || '').trim();
    const api_key = (apiKeyInput?.value || '').trim();
    if (!llm) {
      console.warn('Please select a model');
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
        body: JSON.stringify({ llm, api_key }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Add failed');
      }
      apiKeyInput.value = '';
      await loadAndRender(overlay);
    } catch (e) {
      console.error('Add credential:', e);
    }
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  loadAndRender(overlay);
}
