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
    tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="3">No credentials added yet.</td></tr>';
    return;
  }
  const llmLabel = (v) => ({ openai: 'OpenAI (GPT)', anthropic: 'Anthropic (Claude)', other: 'Other' }[v] || v);
  tbody.innerHTML = list.map((c) => `
    <tr data-credential-id="${c.id}">
      <td>${llmLabel(c.llm)}</td>
      <td><code class="credentials-key-masked">${c.api_key_masked}</code></td>
      <td><button type="button" class="btn btn-secondary credentials-delete-btn" data-id="${c.id}" aria-label="Delete">Delete</button></td>
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
    bindDeleteButtons(overlay);
  } catch (e) {
    console.error('Load credentials:', e);
    const tbody = getTbody(overlay);
    if (tbody) tbody.innerHTML = '<tr class="credentials-table-empty"><td colspan="3">Unable to load (is the backend running?).</td></tr>';
  }
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
          <h3 class="credentials-section-title">LLMs you can use</h3>
          <div class="credentials-table-scroll">
            <table class="credentials-table" aria-label="LLM credentials">
              <thead>
                <tr>
                  <th>LLM</th>
                  <th>API key</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr class="credentials-table-empty">
                  <td colspan="3">No credentials added yet.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="credentials-add">
          <h3 class="credentials-section-title">Create credential</h3>
          <div class="credentials-add-row">
            <div class="credentials-add-field">
              <label class="dataset-meta-label" for="credentials-llm-select">LLM</label>
              <select id="credentials-llm-select" class="credentials-select" aria-label="Select LLM">
                <option value="">Select an LLM...</option>
                <option value="openai">OpenAI (GPT)</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="credentials-add-field credentials-add-field--grow">
              <label class="dataset-meta-label" for="credentials-api-key">API key</label>
              <input type="password" id="credentials-api-key" class="dataset-meta-input" placeholder="Enter your API key" autocomplete="off" />
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

  overlay.querySelector('.credentials-add-btn').addEventListener('click', async () => {
    const llmSelect = overlay.querySelector('#credentials-llm-select');
    const apiKeyInput = overlay.querySelector('#credentials-api-key');
    const llm = (llmSelect?.value || '').trim();
    const api_key = (apiKeyInput?.value || '').trim();
    if (!llm) {
      console.warn('Please select an LLM');
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
