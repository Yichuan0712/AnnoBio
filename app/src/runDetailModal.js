/**
 * Run node detail modal: two-column layout. Left: select working dataset, select LLM (credential), map prompt inputs to columns. Right: run results.
 * @param {{ node: HTMLElement, getWorkingSets: () => Array<...>, getPromptInputFields: () => string[], getSubsetContent?: (nodeId: string) => ..., getPromptTemplate?: () => ..., registerPendingRun?: (nodeId: string, runId: string) => void }} options
 */

const API_BASE = 'http://localhost:8000';
const MAX_CELL_CHARS = 40;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, max = MAX_CELL_CHARS) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function openRunDetailModal({ node, getWorkingSets, getPromptInputFields, getSubsetContent, getPromptTemplate, registerPendingRun }) {
  const workingSets = getWorkingSets ? getWorkingSets() : [];
  const inputFields = getPromptInputFields ? getPromptInputFields() : [];
  getSubsetContent = getSubsetContent || (() => ({ headers: [], rows: [] }));
  getPromptTemplate = getPromptTemplate || (() => ({ sections: [], outputSchema: { return_shape: 'single', fields: [] } }));
  registerPendingRun = registerPendingRun || (() => {});

  let selectedNodeId = (node?.dataset?.runWorkingSetId || '').trim();
  let selectedCredentialId = (node?.dataset?.runCredentialId || '').trim();
  const inputToColumn = (() => {
    try {
      const raw = node?.dataset?.runInputToColumn;
      if (raw) {
        const o = JSON.parse(raw);
        return typeof o === 'object' && o !== null ? o : {};
      }
    } catch (_) {}
    return {};
  })();

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
  const runBtn = overlay.querySelector('.run-detail-run-btn');
  const rightCol = overlay.querySelector('.run-detail-col--right');

  function renderResultsEmptyCard() {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';
    wrap.innerHTML = '<h3 class="run-detail-section-title">Results</h3><p class="run-detail-placeholder">Run to see results.</p>';
    card.appendChild(wrap);
    return card;
  }

  function buildResultsTable(results, outputFields) {
    const tbl = document.createElement('table');
    tbl.className = 'run-detail-results-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="run-detail-th run-detail-th--index">#</th>';
    outputFields.forEach((f) => {
      const th = document.createElement('th');
      th.className = 'run-detail-th';
      th.textContent = f.display || f.key || '';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    results.forEach((r) => {
      const tr = document.createElement('tr');
      const idxCell = document.createElement('td');
      idxCell.className = 'run-detail-td run-detail-td--index';
      idxCell.textContent = String(r.row_index + 1);
      tr.appendChild(idxCell);
      if (r.error) {
        const errCell = document.createElement('td');
        errCell.className = 'run-detail-td run-detail-td--error';
        errCell.setAttribute('colspan', String(Math.max(1, outputFields.length)));
        errCell.textContent = truncate(r.error);
        errCell.title = r.error ?? '';
        tr.appendChild(errCell);
      } else if (r.output && typeof r.output === 'object') {
        outputFields.forEach((f) => {
          const td = document.createElement('td');
          td.className = 'run-detail-td';
          const val = r.output[f.key];
          if (val === null || val === undefined) {
            td.textContent = '—';
          } else if (Array.isArray(val)) {
            const full = val.join(', ');
            td.textContent = truncate(full);
            td.title = full;
          } else {
            const full = String(val);
            td.textContent = truncate(full);
            td.title = full;
          }
          tr.appendChild(td);
        });
      } else {
        outputFields.forEach(() => {
          const td = document.createElement('td');
          td.className = 'run-detail-td';
          td.textContent = '—';
          tr.appendChild(td);
        });
      }
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    return tbl;
  }

  /** status: 'generating' | 'complete' | 'incomplete' */
  function fillResultsWrap(wrap, results, outputFields, status) {
    wrap.innerHTML = '';
    const title = document.createElement('h3');
    title.className = 'run-detail-section-title';
    title.textContent = 'Results';
    wrap.appendChild(title);
    wrap.appendChild(buildResultsTable(results, outputFields));
    if (status === 'generating') {
      const note = document.createElement('p');
      note.className = 'run-detail-results-note run-detail-results-generating';
      note.textContent = 'Results are still generating…';
      wrap.appendChild(note);
    } else if (status === 'complete') {
      const note = document.createElement('p');
      note.className = 'run-detail-results-note run-detail-results-complete';
      note.textContent = 'Results complete.';
      wrap.appendChild(note);
    } else if (status === 'incomplete') {
      const note = document.createElement('p');
      note.className = 'run-detail-results-note run-detail-results-incomplete';
      note.textContent = 'Last run did not complete. Please run again.';
      wrap.appendChild(note);
    }
  }

  function renderResultsTable(results, outputFields, status) {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';
    fillResultsWrap(wrap, results, outputFields, status);
    card.appendChild(wrap);
    const footer = document.createElement('div');
    footer.className = 'run-detail-results-footer';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary run-detail-next-step-btn';
    btn.textContent = 'Next step';
    footer.appendChild(btn);
    card.appendChild(footer);
    return card;
  }

  function updateRunButtonState() {
    runBtn.disabled = !(selectedNodeId && selectedCredentialId);
  }

  function getSelectedWorkingSet() {
    return workingSets.find((ws) => ws.nodeId === selectedNodeId) || null;
  }

  function updateRunNodeBorder() {
    const ws = getSelectedWorkingSet();
    if (node && node.style) {
      const color = ws && ws.color ? ws.color : '';
      node.style.borderColor = color;
      node.dataset.runWorkingSetId = selectedNodeId || '';
      const progressBar = node.querySelector('.workflow-node__run-progress');
      if (progressBar) progressBar.style.background = color;
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
    updateRunButtonState();
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
        if (node) {
          try {
            node.dataset.runInputToColumn = JSON.stringify(inputToColumn);
          } catch (_) {}
        }
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

  function onRunResultsUpdated(e) {
    if (e.detail?.nodeId !== node?.dataset?.nodeId) return;
    const results = e.detail.results;
    const outputFields = e.detail.outputFields;
    const isComplete = e.detail.isComplete !== false;
    if (!Array.isArray(results) || !Array.isArray(outputFields)) return;
    const status = isComplete ? 'complete' : 'generating';
    const scrollWrap = rightCol.querySelector('.run-detail-results');
    if (scrollWrap) {
      fillResultsWrap(scrollWrap, results, outputFields, status);
    } else {
      rightCol.innerHTML = '';
      rightCol.appendChild(renderResultsTable(results, outputFields, status));
    }
  }
  function closeModal() {
    document.removeEventListener('workflow:run-results-updated', onRunResultsUpdated);
    overlay.remove();
    document.body.style.overflow = '';
  }
  document.addEventListener('workflow:run-results-updated', onRunResultsUpdated);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
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
    updateRunButtonState();
  });

  runBtn.addEventListener('click', async () => {
    if (!selectedNodeId || !selectedCredentialId) return;
    const content = getSubsetContent(selectedNodeId);
    const template = getPromptTemplate();
    const headers = content.headers || [];
    const rows = content.rows || [];
    if (rows.length === 0) {
      rightCol.innerHTML = '<p class="run-detail-placeholder">Working dataset has no rows.</p>';
      return;
    }
    const templateText = (template.sections || []).map((s) => (s.content || '').trim()).filter(Boolean).join('\n\n');
    if (!templateText) {
      rightCol.innerHTML = '<p class="run-detail-placeholder">Prompt has no content.</p>';
      return;
    }
    const prompts = rows.map((row) => {
      let text = templateText;
      (inputFields || []).forEach((inputName) => {
        const col = inputToColumn[inputName];
        const idx = headers.indexOf(col);
        const val = idx >= 0 ? (row[idx] ?? '') : '';
        text = text.replace(new RegExp('\\{' + escapeRegex(inputName) + '\\}', 'g'), String(val));
      });
      return text;
    });
    const outputSchema = {
      return_shape: template.outputSchema?.return_shape || 'single',
      fields: (template.outputSchema?.fields || []).map((f) => ({
        key: f.key,
        type: f.type || 'str',
        description: f.description,
        allow_none: f.allowNone ?? f.allow_none ?? false,
      })),
    };
    if (outputSchema.fields.length === 0) {
      rightCol.innerHTML = '<p class="run-detail-placeholder">Prompt output schema has no fields. Add fields in the Prompt node.</p>';
      return;
    }
    if (node) {
      node.dataset.runResults = '';
      node.dataset.runOutputFields = '';
      const bar = node.querySelector('.workflow-node__run-progress');
      if (bar) bar.style.width = '0%';
    }
    const cardRunning = renderResultsEmptyCard();
    const pRunning = cardRunning.querySelector('.run-detail-placeholder');
    if (pRunning) pRunning.textContent = 'Running… Results will appear below as they complete.';
    rightCol.innerHTML = '';
    rightCol.appendChild(cardRunning);
    runBtn.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential_id: selectedCredentialId,
          prompts,
          output_schema: outputSchema,
          run_node_id: node?.dataset?.nodeId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        const runId = data.run_id;
        if (runId && node?.dataset?.nodeId) registerPendingRun(node.dataset.nodeId, runId);
        updateRunButtonState();
        return;
      }
      if (!res.ok) {
        rightCol.innerHTML = '<p class="run-detail-error">' + escapeHtml(data.detail || res.statusText || 'Request failed') + '</p>';
        updateRunButtonState();
        return;
      }
      const results = data.results || [];
      const outputFields = data.output_fields || [];
      rightCol.innerHTML = '';
      rightCol.appendChild(renderResultsTable(results, outputFields, 'complete'));
      if (node) {
        try {
          node.dataset.runResults = JSON.stringify(results);
          node.dataset.runOutputFields = JSON.stringify(outputFields);
        } catch (_) {}
      }
    } catch (e) {
      rightCol.innerHTML = '<p class="run-detail-error">' + escapeHtml(String(e.message || e)) + '</p>';
    } finally {
      updateRunButtonState();
    }
  });

  updateTriggerDisplay();
  updateRunNodeBorder();
  renderInputMappings();
  updateRunButtonState();
  loadCredentialsAndPopulateLlm();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  // Show Results card immediately: restore saved results or placeholder
  rightCol.innerHTML = '';
  try {
    const savedResults = node?.dataset?.runResults;
    const savedFields = node?.dataset?.runOutputFields;
    if (savedResults && savedFields) {
      const results = JSON.parse(savedResults);
      const outputFields = JSON.parse(savedFields);
      if (Array.isArray(results) && Array.isArray(outputFields)) {
        const progressBar = node?.querySelector('.workflow-node__run-progress');
        const isRunComplete = progressBar?.getAttribute('aria-valuenow') === '100';
        const status = isRunComplete ? 'complete' : 'incomplete';
        rightCol.appendChild(renderResultsTable(results, outputFields, status));
      } else {
        rightCol.appendChild(renderResultsEmptyCard());
      }
    } else {
      rightCol.appendChild(renderResultsEmptyCard());
    }
  } catch (_) {
    rightCol.appendChild(renderResultsEmptyCard());
  }
}
