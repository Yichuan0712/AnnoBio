/**
 * Run node detail modal: two-column layout. Left: select working dataset, select LLM (credential), map prompt inputs to columns.
 * @param {{ node: HTMLElement, getWorkingSets: () => Array<{ nodeId: string, name: string, headers: string[], color?: string }>, getPromptInputFields: () => string[] }} options
 */

const API_BASE = 'http://localhost:8000';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function openRunDetailModal({ node, getWorkingSets, getPromptInputFields }) {
  const workingSets = getWorkingSets ? getWorkingSets() : [];
  const inputFields = getPromptInputFields ? getPromptInputFields() : [];

  let selectedNodeId = (node?.dataset?.runWorkingSetId || '').trim();
  let selectedCredentialId = (node?.dataset?.runCredentialId || '').trim();
  const inputToColumn = {};

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'run-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--run-detail">
      <div class="modal-header">
        <h2 id="run-detail-title" class="modal-title">Run details</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body run-detail-body">
        <div class="run-detail-col run-detail-col--left">
          <div class="run-detail-card">
            <div class="run-detail-row">
              <label class="run-detail-label" for="run-detail-ws-picker">WORKING DATASET</label>
              <div class="run-detail-ws-picker" id="run-detail-ws-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Select working dataset">
                <div class="run-detail-ws-trigger" tabindex="0">
                  <span class="run-detail-ws-trigger-color" id="run-detail-ws-trigger-color"></span>
                  <span class="run-detail-ws-trigger-text" id="run-detail-ws-trigger-text">— Select working dataset —</span>
                  <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                </div>
                <div class="run-detail-ws-dropdown" id="run-detail-ws-dropdown" role="listbox" hidden></div>
              </div>
            </div>
            <div class="run-detail-inputs-section" id="run-detail-inputs-section">
              <h3 class="run-detail-section-title">Map dataset columns to prompt inputs</h3>
              <div class="run-detail-mapping-wrap" id="run-detail-inputs-list"></div>
            </div>
            <div class="run-detail-row">
              <label class="run-detail-label" for="run-detail-llm-select">MODEL FOR PROMPT</label>
              <select id="run-detail-llm-select" class="run-detail-llm-select" aria-label="Select model for prompt">
                <option value="">— Select model for prompt —</option>
              </select>
            </div>
            <div class="run-detail-footer">
              <button type="button" class="btn btn-secondary run-detail-run-btn" disabled>Run</button>
            </div>
          </div>
        </div>
        <div class="run-detail-col run-detail-col--right">
        </div>
      </div>
    </div>
  `;

  const pickerEl = overlay.querySelector('#run-detail-ws-picker');
  const triggerEl = overlay.querySelector('.run-detail-ws-trigger');
  const triggerColorEl = overlay.querySelector('#run-detail-ws-trigger-color');
  const triggerTextEl = overlay.querySelector('#run-detail-ws-trigger-text');
  const dropdownEl = overlay.querySelector('#run-detail-ws-dropdown');
  const llmSelectEl = overlay.querySelector('#run-detail-llm-select');
  const inputsListEl = overlay.querySelector('#run-detail-inputs-list');

  function getSelectedWorkingSet() {
    return workingSets.find((ws) => ws.nodeId === selectedNodeId) || null;
  }

  function updateRunNodeBorder() {
    const ws = getSelectedWorkingSet();
    if (node && node.style) {
      node.style.borderColor = ws && ws.color ? ws.color : '';
      node.dataset.runWorkingSetId = selectedNodeId || '';
    }
  }

  function updateTriggerDisplay() {
    const ws = getSelectedWorkingSet();
    if (ws) {
      triggerColorEl.style.background = ws.color || 'transparent';
      triggerColorEl.style.display = ws.color ? '' : 'none';
      triggerTextEl.textContent = ws.name || 'WORKING DATASET';
    } else {
      triggerColorEl.style.background = '';
      triggerColorEl.style.display = 'none';
      triggerTextEl.textContent = '— Select working dataset —';
    }
  }

  function closeDropdown() {
    dropdownEl.hidden = true;
    pickerEl.setAttribute('aria-expanded', 'false');
  }

  function openDropdown() {
    dropdownEl.hidden = false;
    pickerEl.setAttribute('aria-expanded', 'true');
  }

  function selectWorkingSet(id) {
    selectedNodeId = id || '';
    updateTriggerDisplay();
    updateRunNodeBorder();
    closeDropdown();
    dropdownEl.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', o.dataset.nodeId === selectedNodeId ? 'true' : 'false'));
    renderInputMappings();
  }

  function populateDropdown() {
    dropdownEl.innerHTML = '';
    const emptyOption = document.createElement('div');
    emptyOption.className = 'run-detail-ws-option';
    emptyOption.setAttribute('role', 'option');
    emptyOption.setAttribute('aria-selected', !selectedNodeId ? 'true' : 'false');
    emptyOption.innerHTML = '<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">— Select working dataset —</span>';
    emptyOption.dataset.nodeId = '';
    emptyOption.addEventListener('click', () => selectWorkingSet(''));
    dropdownEl.appendChild(emptyOption);
    workingSets.forEach((ws) => {
      const option = document.createElement('div');
      option.className = 'run-detail-ws-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', ws.nodeId === selectedNodeId ? 'true' : 'false');
      option.innerHTML = `<span class="run-detail-ws-option-color" style="background:${escapeHtml(ws.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(ws.name || 'WORKING DATASET')}</span>`;
      option.dataset.nodeId = ws.nodeId;
      option.addEventListener('click', () => selectWorkingSet(ws.nodeId));
      dropdownEl.appendChild(option);
    });
  }

  function renderInputMappings() {
    const ws = getSelectedWorkingSet();
    const headers = ws ? (ws.headers || []).slice() : [];
    inputsListEl.innerHTML = '';
    if (inputFields.length === 0) {
      inputsListEl.innerHTML = '<p class="run-detail-placeholder">No prompt inputs.</p>';
      return;
    }
    const table = document.createElement('div');
    table.className = 'run-detail-mapping-table';
    table.setAttribute('role', 'table');
    table.innerHTML = `
      <div class="run-detail-mapping-head" role="row">
        <span class="run-detail-mapping-th run-detail-mapping-th--column" role="columnheader">Dataset column</span>
        <span class="run-detail-mapping-th run-detail-mapping-th--arrow" aria-hidden="true">→</span>
        <span class="run-detail-mapping-th run-detail-mapping-th--input" role="columnheader">Prompt input</span>
      </div>
    `;
    inputFields.forEach((inputName) => {
      const currentCol = inputToColumn[inputName] || '';
      const row = document.createElement('div');
      row.className = 'run-detail-mapping-row';
      row.setAttribute('role', 'row');
      row.innerHTML = `
        <span class="run-detail-mapping-cell run-detail-mapping-cell--column" role="cell">
          <select class="run-detail-column-select" data-input="${escapeAttr(inputName)}" aria-label="Dataset column for ${escapeAttr(inputName)}">
            <option value="">— Select column —</option>
            ${headers.map((h) => `<option value="${escapeAttr(h)}" ${h === currentCol ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
          </select>
        </span>
        <span class="run-detail-mapping-cell run-detail-mapping-cell--arrow" aria-hidden="true">→</span>
        <span class="run-detail-mapping-cell run-detail-mapping-cell--input" role="cell"><span class="prompt-detail-input-tag">${escapeHtml(inputName)}</span></span>
      `;
      const sel = row.querySelector('.run-detail-column-select');
      sel.addEventListener('change', () => {
        inputToColumn[inputName] = sel.value.trim() || '';
      });
      table.appendChild(row);
    });
    inputsListEl.appendChild(table);
  }

  function escapeAttr(str) {
    const s = String(str ?? '');
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  triggerEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (dropdownEl.hidden) {
      populateDropdown();
      openDropdown();
    } else {
      closeDropdown();
    }
  });
  triggerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (dropdownEl.hidden) {
        populateDropdown();
        openDropdown();
      } else {
        closeDropdown();
      }
    }
  });
  overlay.addEventListener('click', (e) => {
    if (pickerEl.contains(e.target)) return;
    closeDropdown();
  });

  overlay.querySelector('.modal-close').addEventListener('click', () => {
    overlay.remove();
    document.body.style.overflow = '';
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      document.body.style.overflow = '';
    }
  });

  async function loadCredentialsAndPopulateLlm() {
    const sel = llmSelectEl;
    sel.innerHTML = '<option value="">— Select model for prompt —</option>';
    try {
      const res = await fetch(`${API_BASE}/api/credentials`);
      if (!res.ok) return;
      const list = await res.json();
      list.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name || c.llm || c.id;
        sel.appendChild(opt);
      });
      if (selectedCredentialId) sel.value = selectedCredentialId;
    } catch (e) {
      console.error('Load credentials for LLM select:', e);
    }
  }

  llmSelectEl.addEventListener('change', () => {
    selectedCredentialId = (llmSelectEl.value || '').trim();
    if (node) node.dataset.runCredentialId = selectedCredentialId || '';
  });

  updateTriggerDisplay();
  updateRunNodeBorder();
  renderInputMappings();
  loadCredentialsAndPopulateLlm();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
