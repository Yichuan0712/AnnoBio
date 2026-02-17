/**
 * Run node detail modal: two-column layout. Left: select dataset, select LLM (credential), map prompt inputs to columns. Right: run results.
 * @param {{ node: HTMLElement, getWorkingSets: () => Array<...>, getPromptInputFields: () => string[], getSubsetContent?: (nodeId: string) => ..., getPromptTemplate?: () => ..., registerPendingRun?: (nodeId: string, runId: string) => void }} options
 */

const API_BASE = 'http://localhost:8000';
const MAX_CELL_CHARS = 40;
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

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

/** Filter results by search query (match row #, error, any output cell, or working row cells). */
function filterResultsBySearch(results, outputFields, searchQuery, workingContent) {
  const q = (searchQuery || '').trim().toLowerCase();
  if (!q) return results;
  const wsRows = (workingContent && workingContent.rows) || [];
  return results.filter((r) => {
    if (String(r.row_index + 1).toLowerCase().includes(q)) return true;
    if (r.error && String(r.error).toLowerCase().includes(q)) return true;
    const wsRow = Array.isArray(wsRows[r.row_index]) ? wsRows[r.row_index] : [];
    for (const val of wsRow) {
      if (val !== null && val !== undefined && String(val).toLowerCase().includes(q)) return true;
    }
    if (r.output && typeof r.output === 'object') {
      for (const f of outputFields || []) {
        const val = r.output[f.key];
        if (val !== null && val !== undefined && String(val).toLowerCase().includes(q)) return true;
        if (Array.isArray(val) && val.some((v) => String(v).toLowerCase().includes(q))) return true;
      }
    }
    return false;
  });
}

export function openRunDetailModal({ node, getWorkingSets, getPromptInputFields, getSubsetContent, getPromptTemplate, registerPendingRun, getPromptName, getUniqueDatasetExportName, isRunNameAlreadyUsedForPrompt }) {
  const workingSets = getWorkingSets ? getWorkingSets() : [];
  const inputFields = getPromptInputFields ? getPromptInputFields() : [];
  getSubsetContent = getSubsetContent || (() => ({ headers: [], rows: [] }));
  getPromptTemplate = getPromptTemplate || (() => ({ sections: [], outputSchema: { return_shape: 'single', fields: [] } }));
  registerPendingRun = registerPendingRun || (() => {});
  getPromptName = getPromptName || (() => '');
  getUniqueDatasetExportName = getUniqueDatasetExportName || ((name) => name);
  isRunNameAlreadyUsedForPrompt = isRunNameAlreadyUsedForPrompt || (() => false);

  let selectedNodeId = (node?.dataset?.runWorkingSetId || '').trim();
  let selectedCredentialId = (node?.dataset?.runCredentialId || '').trim();
  let runName = (node?.dataset?.runName || node?.querySelector?.('.workflow-node__title')?.textContent?.trim() || 'Run').trim() || 'Run';
  const resultsState = {
    results: [],
    outputFields: [],
    workingContent: null,
    status: 'complete',
    searchQuery: '',
    rowsPerPage: 25,
    currentPage: 1,
    bracketColsCollapsed: node?.dataset?.runBracketColsCollapsed !== '0',
  };
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

  const titleText = `Run: ${runName}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'run-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--run-detail">
      <div class="modal-header">
        <h2 id="run-detail-title" class="modal-title">${escapeHtml(titleText)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body run-detail-body modal-body--run">
        <div class="run-detail-main">
          <p class="run-detail-main-label">Run settings</p>
          <div class="dataset-meta-wrap run-detail-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="run-detail-ws-picker">Dataset</label>
              <div class="run-detail-ws-picker" id="run-detail-ws-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Select dataset">
                <div class="run-detail-ws-trigger" tabindex="0">
                  <span class="run-detail-ws-trigger-color" id="run-detail-ws-trigger-color"></span>
                  <span class="run-detail-ws-trigger-text" id="run-detail-ws-trigger-text">— Select dataset —</span>
                  <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                </div>
                <div class="run-detail-ws-dropdown" id="run-detail-ws-dropdown" role="listbox" hidden></div>
              </div>
            </div>
            <div class="run-detail-inputs-section dataset-meta-field" id="run-detail-inputs-section">
              <span class="dataset-meta-label run-detail-section-label">Map dataset columns to prompt inputs</span>
              <div class="run-detail-mapping-wrap" id="run-detail-inputs-list"></div>
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="run-detail-llm-select">Model for prompt</label>
              <select id="run-detail-llm-select" class="run-detail-llm-select dataset-meta-input" aria-label="Select model for prompt">
                <option value="">— Select model —</option>
              </select>
            </div>
          </div>
          <div class="prompt-form-error prompt-modal-error run-detail-form-error" id="run-detail-form-error" role="alert" aria-live="polite" hidden></div>
          <div class="prompt-actions run-detail-actions">
            <button type="button" class="btn btn-secondary run-detail-run-btn" disabled>Run</button>
          </div>
        </div>
        <div class="run-detail-preview-wrap">
          <h3 class="run-detail-preview-title">Results</h3>
          <div class="run-detail-preview-content"></div>
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
  const rightCol = overlay.querySelector('.run-detail-preview-content');
  const runDetailPanel = overlay.querySelector('.modal-panel--run-detail');
  const modalTitleEl = overlay.querySelector('#run-detail-title');

  const runDetailFormErrorEl = overlay.querySelector('#run-detail-form-error');

  /** 展开右半部分：panel 变宽并显示右侧结果区（与 add prompt 从 step1 到 step2 一致，带动画） */
  function expandRightPanel() {
    if (runDetailPanel && !runDetailPanel.classList.contains('run-detail-panel--expanded')) {
      runDetailPanel.classList.add('run-detail-panel--expanded');
    }
  }

  function renderResultsEmptyCard() {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';
    wrap.innerHTML = '<p class="run-detail-placeholder">Run to see results.</p>';
    card.appendChild(wrap);
    return card;
  }

  /** workingContent: { headers: string[], rows: any[][] }. Columns with [] at end; if bracketColsCollapsed, show as single "..." column (click to expand). */
  function buildResultsTable(results, outputFields, workingContent, bracketColsCollapsed, onToggleCollapse) {
    const wsHeaders = (workingContent && workingContent.headers) || [];
    const wsRows = (workingContent && workingContent.rows) || [];
    const collapsed = !!bracketColsCollapsed;
    const hasBracketCols = wsHeaders.length >= 0;
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
    if (hasBracketCols) {
      const thBracket = document.createElement('th');
      thBracket.className = 'run-detail-th run-detail-th--dataset-row-col run-detail-th--bracket-toggle';
      thBracket.textContent = collapsed ? '...' : 'Input: #';
      thBracket.title = collapsed ? 'Click to expand. These columns show the corresponding input dataset rows.' : 'Click to collapse. These columns show the corresponding input dataset rows.';
      thBracket.setAttribute('role', 'button');
      thBracket.setAttribute('tabindex', '0');
      if (typeof onToggleCollapse === 'function') {
        thBracket.addEventListener('click', onToggleCollapse);
        thBracket.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse(); } });
      }
      headerRow.appendChild(thBracket);
      if (!collapsed) {
        wsHeaders.forEach((h) => {
          const th = document.createElement('th');
          th.className = 'run-detail-th run-detail-th--dataset-row-col';
          th.textContent = `Input: ${String(h ?? '').trim() || ' '}`;
          headerRow.appendChild(th);
        });
      }
    }
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
        outputFields.forEach(() => {
          const td = document.createElement('td');
          td.className = 'run-detail-td run-detail-td--error';
          td.textContent = truncate(r.error);
          td.title = r.error ?? '';
          tr.appendChild(td);
        });
      } else {
        if (r.output && typeof r.output === 'object') {
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
      }
      if (hasBracketCols) {
        if (collapsed) {
          const td = document.createElement('td');
          td.className = 'run-detail-td run-detail-td--dataset-row-col';
          td.textContent = '...';
          td.title = '...';
          tr.appendChild(td);
        } else {
          const datasetRowCell = document.createElement('td');
          datasetRowCell.className = 'run-detail-td run-detail-td--dataset-row-col';
          datasetRowCell.textContent = String(r.row_index + 1);
          tr.appendChild(datasetRowCell);
          const wsRow = Array.isArray(wsRows[r.row_index]) ? wsRows[r.row_index] : [];
          wsHeaders.forEach((_, i) => {
            const td = document.createElement('td');
            td.className = 'run-detail-td run-detail-td--dataset-row-col';
            const val = wsRow[i];
            if (val === null || val === undefined) {
              td.textContent = '—';
            } else {
              const full = String(val);
              td.textContent = truncate(full);
              td.title = full;
            }
            tr.appendChild(td);
          });
        }
      }
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    return tbl;
  }

  function getStatusNoteText(status, hasResults) {
    if (!hasResults) return '';
    if (status === 'generating') return 'Results are still generating…';
    if (status === 'complete') return 'Results complete.';
    if (status === 'incomplete') return 'Last run did not complete. Please run again.';
    return '';
  }

  /** status: 'generating' | 'complete' | 'incomplete' */
  function fillResultsWrap(card, results, outputFields, status) {
    resultsState.results = results || [];
    resultsState.outputFields = outputFields || [];
    resultsState.workingContent = getSubsetContent(selectedNodeId) || null;
    resultsState.status = status || 'complete';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';
    if (resultsState.results.length === 0) {
      const placeholder = document.createElement('p');
      placeholder.className = 'run-detail-placeholder';
      placeholder.textContent = status === 'generating' ? 'Running… Results will appear below as they complete.' : 'Run to see results.';
      wrap.appendChild(placeholder);
    } else {
      const topRow = document.createElement('div');
      topRow.className = 'run-detail-results-top-row';
      const statusNote = document.createElement('span');
      statusNote.className = 'run-detail-results-note run-detail-results-note--inline';
      if (status === 'generating') statusNote.classList.add('run-detail-results-generating');
      else if (status === 'complete') statusNote.classList.add('run-detail-results-complete');
      else if (status === 'incomplete') statusNote.classList.add('run-detail-results-incomplete');
      statusNote.textContent = getStatusNoteText(status, true);
      topRow.appendChild(statusNote);
      const searchWrap = document.createElement('div');
      searchWrap.className = 'dataset-detail-preview-search-wrap run-detail-results-search-wrap';
      searchWrap.innerHTML = `
        <label class="dataset-detail-search-label" for="run-detail-results-search">Search</label>
        <input type="text" id="run-detail-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" />
      `;
      topRow.appendChild(searchWrap);
      wrap.appendChild(topRow);
      const tableWrap = document.createElement('div');
      tableWrap.className = 'run-detail-results-table-wrap';
      wrap.appendChild(tableWrap);
      const searchInp = wrap.querySelector('#run-detail-results-search');
      const toolbar = document.createElement('div');
      toolbar.className = 'dataset-detail-preview-toolbar run-detail-results-toolbar';
      toolbar.innerHTML = `
        <label class="dataset-detail-rows-label" for="run-detail-rows-per-page">Rows per page</label>
        <select id="run-detail-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">
          ${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === resultsState.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <span class="dataset-detail-pagination-info run-detail-pagination-info" aria-live="polite"></span>
        <label class="dataset-detail-page-label" for="run-detail-page-inp">Page</label>
        <input type="number" id="run-detail-page-inp" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page number" />
        <span class="dataset-detail-page-of run-detail-page-of">/ 1</span>
        <div class="dataset-detail-pagination-btns">
          <button type="button" class="btn btn-secondary run-detail-prev-page" aria-label="Previous page">Previous</button>
          <button type="button" class="btn btn-secondary run-detail-next-page" aria-label="Next page">Next</button>
        </div>
      `;
      const rowsPerPageSelect = toolbar.querySelector('#run-detail-rows-per-page');
      const paginationInfo = toolbar.querySelector('.run-detail-pagination-info');
      const pageInp = toolbar.querySelector('#run-detail-page-inp');
      const pageOfSpan = toolbar.querySelector('.run-detail-page-of');
      const prevBtn = toolbar.querySelector('.run-detail-prev-page');
      const nextBtn = toolbar.querySelector('.run-detail-next-page');

      function updateResultsTable() {
        const filtered = filterResultsBySearch(resultsState.results, resultsState.outputFields, resultsState.searchQuery, resultsState.workingContent);
        const totalPages = Math.max(1, Math.ceil(filtered.length / resultsState.rowsPerPage));
        resultsState.currentPage = Math.min(Math.max(1, resultsState.currentPage), totalPages);
        const start = (resultsState.currentPage - 1) * resultsState.rowsPerPage;
        const end = Math.min(start + resultsState.rowsPerPage, filtered.length);
        const pageResults = filtered.slice(start, end);
        function onToggleBracketCollapse() {
          resultsState.bracketColsCollapsed = !resultsState.bracketColsCollapsed;
          if (node) node.dataset.runBracketColsCollapsed = resultsState.bracketColsCollapsed ? '1' : '0';
          updateResultsTable();
        }
        tableWrap.innerHTML = '';
        tableWrap.appendChild(buildResultsTable(pageResults, resultsState.outputFields, resultsState.workingContent, resultsState.bracketColsCollapsed, onToggleBracketCollapse));
        const totalFiltered = filtered.length;
        const totalRows = resultsState.results.length;
        if (totalFiltered === 0) {
          paginationInfo.textContent = totalRows === 0 ? '0 rows' : `0 rows (filtered from ${totalRows.toLocaleString()})`;
        } else {
          paginationInfo.textContent = totalFiltered === totalRows
            ? `Showing ${start + 1}–${end} of ${totalRows.toLocaleString()} rows`
            : `Showing ${start + 1}–${end} of ${totalFiltered.toLocaleString()} (filtered from ${totalRows.toLocaleString()}) rows`;
        }
        pageInp.value = String(resultsState.currentPage);
        pageInp.max = String(totalPages);
        pageOfSpan.textContent = `/ ${totalPages}`;
        prevBtn.disabled = resultsState.currentPage <= 1;
        nextBtn.disabled = resultsState.currentPage >= totalPages;
      }

      searchInp.addEventListener('input', () => {
        resultsState.searchQuery = searchInp.value;
        resultsState.currentPage = 1;
        updateResultsTable();
      });
      rowsPerPageSelect.addEventListener('change', () => {
        resultsState.rowsPerPage = Number(rowsPerPageSelect.value) || 25;
        resultsState.currentPage = 1;
        updateResultsTable();
      });
      pageInp.addEventListener('change', () => {
        resultsState.currentPage = Math.max(1, parseInt(pageInp.value, 10) || 1);
        updateResultsTable();
      });
      prevBtn.addEventListener('click', () => {
        resultsState.currentPage = Math.max(1, resultsState.currentPage - 1);
        updateResultsTable();
      });
      nextBtn.addEventListener('click', () => {
        const totalPages = Math.max(1, Math.ceil(filterResultsBySearch(resultsState.results, resultsState.outputFields, resultsState.searchQuery, resultsState.workingContent).length / resultsState.rowsPerPage));
        resultsState.currentPage = Math.min(totalPages, resultsState.currentPage + 1);
        updateResultsTable();
      });
      wrap._updateResultsTable = updateResultsTable;
      updateResultsTable();

      const footer = document.createElement('div');
      footer.className = 'run-detail-results-footer';
      footer.appendChild(toolbar);
      const footerActions = document.createElement('div');
      footerActions.className = 'run-detail-results-footer-actions';
      function doSaveToWorkspace() {
        const promptName = (getPromptName() || '').trim() || 'Prompt';
        const baseName = `${promptName} ${runName}`.trim();
        const datasetName = getUniqueDatasetExportName(baseName);
        const statusLine = resultsState.status === 'complete' ? 'Run completed.' : 'Run incomplete.';
        const description = `Exported from ${promptName} ${runName}.\n${statusLine}`;
        const outputFields = resultsState.outputFields || [];
        const workingContent = resultsState.workingContent || { headers: [], rows: [] };
        const wsHeaders = workingContent.headers || [];
        const wsRows = workingContent.rows || [];
        const outputHeaders = outputFields.map((f) => (f.display || f.key || '').trim() || 'output');
        const inputHeaders = wsHeaders.map((h) => 'Input: ' + String(h ?? '').trim() || ' ');
        const headers = [...outputHeaders, ...inputHeaders];
        const rows = (resultsState.results || []).map((r) => {
          const outputPart = r.error
            ? outputFields.map(() => String(r.error))
            : outputFields.map((f) => {
                const val = r.output && r.output[f.key];
                if (val === null || val === undefined) return '—';
                if (Array.isArray(val)) return val.join(', ');
                return String(val);
              });
          const inputRow = Array.isArray(wsRows[r.row_index]) ? wsRows[r.row_index] : [];
          const inputPart = wsHeaders.map((_, i) => {
            const v = inputRow[i];
            return v === null || v === undefined ? '—' : String(v);
          });
          return [...outputPart, ...inputPart];
        });
        document.dispatchEvent(
          new CustomEvent('workflow:add-dataset-node', {
            detail: { name: datasetName, notes: description, headers, rows },
          })
        );
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary run-detail-save-to-workspace-btn';
      btn.textContent = 'Save to workspace';
      btn.addEventListener('click', () => {
        doSaveToWorkspace();
        closeModal();
      });
      footerActions.appendChild(btn);
      const saveAndScoreBtn = document.createElement('button');
      saveAndScoreBtn.type = 'button';
      saveAndScoreBtn.className = 'btn btn-secondary run-detail-save-to-workspace-score-btn';
      saveAndScoreBtn.textContent = 'Score';
      saveAndScoreBtn.addEventListener('click', () => {
        document.dispatchEvent(
          new CustomEvent('workflow:add-score-node', { detail: { runNodeId: node?.dataset?.nodeId || '' } })
        );
        closeModal();
      });
      footerActions.appendChild(saveAndScoreBtn);
      footer.appendChild(footerActions);
      card.appendChild(wrap);
      card.appendChild(footer);
      return;
    }
    /* 无结果（未运行或运行中尚无数据）时不显示 Save to workspace，至少跑完一行后才显示 */
    card.appendChild(wrap);
  }

  function renderResultsTable(results, outputFields, status) {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    fillResultsWrap(card, results, outputFields, status);
    card._updateResults = () => {
      const w = card.querySelector('.run-detail-results');
      if (w && w._updateResultsTable) w._updateResultsTable();
    };
    return card;
  }

  function isRunCompleted() {
    return node?.dataset?.runCompleted === '1';
  }

  function applyRunCompletedLock() {
    if (!isRunCompleted()) return;
    runBtn.disabled = true;
    runBtn.textContent = 'Run completed';
    runBtn.setAttribute('aria-label', 'Run completed');
    llmSelectEl.disabled = true;
    pickerEl.classList.add('run-detail-ws-picker--locked');
    pickerEl.setAttribute('aria-disabled', 'true');
    inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
    const leftMain = overlay.querySelector('.run-detail-main');
    if (leftMain) leftMain.classList.add('run-detail-main--locked');
  }

  function updateRunButtonState() {
    if (isRunCompleted()) {
      runBtn.disabled = true;
      return;
    }
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
      triggerTextEl.textContent = ws.name || 'Dataset';
    } else {
      triggerColorEl.style.background = '';
      triggerColorEl.style.display = 'none';
      triggerTextEl.textContent = '— Select dataset —';
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
    emptyOption.innerHTML = '<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">— Select dataset —</span>';
    emptyOption.dataset.nodeId = '';
    emptyOption.addEventListener('click', () => selectWorkingSet(''));
    dropdownEl.appendChild(emptyOption);
    workingSets.forEach((ws) => {
      const option = document.createElement('div');
      option.className = 'run-detail-ws-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', ws.nodeId === selectedNodeId ? 'true' : 'false');
      option.innerHTML = `<span class="run-detail-ws-option-color" style="background:${escapeHtml(ws.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(ws.name || 'Dataset')}</span>`;
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
        <span class="run-detail-mapping-cell run-detail-mapping-cell--input" role="cell">${escapeHtml(inputName)}</span>
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
    if (isRunCompleted()) return;
    if (dropdownEl.hidden) {
      populateDropdown();
      openDropdown();
    } else {
      closeDropdown();
    }
  });
  triggerEl.addEventListener('keydown', (e) => {
    if (isRunCompleted()) return;
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
    if (isComplete && node) node.dataset.runCompleted = '1';
    if (!Array.isArray(results) || !Array.isArray(outputFields)) return;
    const status = isComplete ? 'complete' : 'generating';
    const card = rightCol.querySelector('.run-detail-results-card');
    if (card) {
      card.innerHTML = '';
      fillResultsWrap(card, results, outputFields, status);
      card._updateResults = () => {
        const w = card.querySelector('.run-detail-results');
        if (w && w._updateResultsTable) w._updateResultsTable();
      };
    } else {
      rightCol.innerHTML = '';
      rightCol.appendChild(renderResultsTable(results, outputFields, status));
    }
    if (isComplete) applyRunCompletedLock();
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
    if (isRunCompleted()) return;
    if (!selectedNodeId || !selectedCredentialId) return;
    const content = getSubsetContent(selectedNodeId);
    const template = getPromptTemplate();
    const headers = content.headers || [];
    const rows = content.rows || [];
    if (rows.length === 0) {
      rightCol.innerHTML = '<p class="run-detail-placeholder">Dataset has no rows.</p>';
      expandRightPanel();
      return;
    }
    const templateText = (template.sections || []).map((s) => (s.content || '').trim()).filter(Boolean).join('\n\n');
    if (!templateText) {
      rightCol.innerHTML = '<p class="run-detail-placeholder">Prompt has no content.</p>';
      expandRightPanel();
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
      expandRightPanel();
      return;
    }
    if (node) {
      node.dataset.runResults = '';
      node.dataset.runOutputFields = '';
      node.dataset.runCompleted = '';
      const bar = node.querySelector('.workflow-node__run-progress');
      if (bar) bar.style.width = '0%';
    }
    const cardRunning = renderResultsEmptyCard();
    const pRunning = cardRunning.querySelector('.run-detail-placeholder');
    if (pRunning) pRunning.textContent = 'Running… Results will appear below as they complete.';
    rightCol.innerHTML = '';
    rightCol.appendChild(cardRunning);
    expandRightPanel();
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
        expandRightPanel();
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
      expandRightPanel();
    } finally {
      updateRunButtonState();
    }
  });

  updateTriggerDisplay();
  updateRunNodeBorder();
  renderInputMappings();
  updateRunButtonState();
  applyRunCompletedLock();
  loadCredentialsAndPopulateLlm();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  // Show Results card immediately: restore saved results or placeholder; expand right panel only if run had been started (has results or we will show placeholder)
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
        expandRightPanel();
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
