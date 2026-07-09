/**
 * Python settings modal: a single field for the Python interpreter (system install or a
 * venv) that Process nodes use to run user code. Separate from the Model settings modal --
 * this isn't an LLM credential, it's a local interpreter path. Saves instantly on change
 * (blur / Browse / Clear), same as the rest of this app's settings -- no Save/Cancel step.
 */

import { BACKEND_API_BASE } from './backendConfig.js';

const API_BASE = BACKEND_API_BASE;

export function openPythonSettingsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'python-settings-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--python-settings">
      <div class="modal-header">
        <h2 id="python-settings-title" class="modal-title">Python settings</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="dataset-meta-field">
          <label class="dataset-meta-label" for="python-settings-path">Python interpreter</label>
          <div class="settings-python-path-row">
            <input type="text" id="python-settings-path" class="dataset-meta-input" placeholder="e.g. python3, or /path/to/venv/bin/python" autocomplete="off" aria-label="Python interpreter path" />
            <button type="button" class="btn btn-secondary" id="python-settings-browse">Browse…</button>
            <button type="button" class="btn btn-secondary" id="python-settings-test">Test</button>
            <button type="button" class="btn btn-secondary" id="python-settings-clear">Clear</button>
          </div>
          <span class="settings-python-status" id="python-settings-status" aria-live="polite"></span>
          <p class="process-editor-hint">Used by Process nodes to run your Python code. Point this at any interpreter with the packages you need, e.g., a system install or a project venv.</p>
        </div>
      </div>
    </div>
  `;

  const pathInp = overlay.querySelector('#python-settings-path');
  const browseBtn = overlay.querySelector('#python-settings-browse');
  const testBtn = overlay.querySelector('#python-settings-test');
  const clearBtn = overlay.querySelector('#python-settings-clear');
  const statusEl = overlay.querySelector('#python-settings-status');

  let lastSaved = '';

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = `settings-python-status${kind ? ` settings-python-status--${kind}` : ''}`;
  }

  function closeModal() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  async function saveIfChanged() {
    const python_path = (pathInp.value || '').trim();
    if (python_path === lastSaved) return;
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Save failed');
      lastSaved = python_path;
    } catch (e) {
      setStatus((e && e.message) || 'Failed to save', 'error');
    }
  }

  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  pathInp.addEventListener('blur', saveIfChanged);
  pathInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') pathInp.blur(); });

  browseBtn.addEventListener('click', async () => {
    try {
      const picked = await window.electronAPI?.showPickPythonDialog?.();
      if (picked) {
        pathInp.value = picked;
        setStatus('', null);
        await saveIfChanged();
      }
    } catch (e) {
      console.error('Pick python interpreter:', e);
    }
  });

  clearBtn.addEventListener('click', async () => {
    pathInp.value = '';
    setStatus('', null);
    await saveIfChanged();
    pathInp.focus();
  });

  testBtn.addEventListener('click', async () => {
    const python_path = (pathInp.value || '').trim();
    if (!python_path) {
      setStatus('Enter or browse to an interpreter path first.', 'error');
      return;
    }
    testBtn.disabled = true;
    setStatus('Checking…', null);
    try {
      const res = await fetch(`${API_BASE}/api/process/check-python`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setStatus(`OK — ${data.version || 'found'}`, 'ok');
      } else {
        setStatus(data.error || 'Not found', 'error');
      }
    } catch (e) {
      setStatus((e && e.message) || 'Network error', 'error');
    } finally {
      testBtn.disabled = false;
    }
  });

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings`);
      const settings = res.ok ? await res.json() : null;
      lastSaved = settings?.python_path || '';
      pathInp.value = lastSaved;
    } catch (e) {
      console.error('Load Python settings:', e);
    }
  })();
}
