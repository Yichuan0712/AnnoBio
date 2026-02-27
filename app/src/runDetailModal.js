/**
 * Run 节点详情弹窗
 *
 * 功能：对 Prompt 做批量运行。选数据集、选模型、配置列映射，按行调用 LLM，右侧表格显示结果。
 *
 * 打开时：左侧配置，右侧显示之前结果（如有）。不自动运行。
 *
 * 按钮：Run（从头跑）| Resume（接着跑）| Running（跑中禁用）| Run completed（跑完禁用）
 */

const API_BASE = 'http://localhost:8000';
const MAX_CELL_CHARS = 40;
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
const STATUS_TEXT = {
  generating: 'Results are still generating…',
  complete: 'Results complete.',
  incomplete: 'Last run did not complete.',
};

/** 跨会话记忆：input 名称 -> 上次选的列名 */
const inputNameToColumnMemory = {};

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

function escapeAttr(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function filterResults(results, outputFields, searchQuery, workingContent) {
  const q = (searchQuery || '').trim().toLowerCase();
  if (!q) return results;
  const wsRows = (workingContent?.rows) || [];
  return results.filter((r) => {
    if (String(r.row_index + 1).toLowerCase().includes(q)) return true;
    if (r.error && String(r.error).toLowerCase().includes(q)) return true;
    const inpIdx = r.input_row_index ?? r.row_index ?? 0;
    const wsRow = Array.isArray(wsRows[inpIdx]) ? wsRows[inpIdx] : [];
    if (wsRow.some((v) => v != null && String(v).toLowerCase().includes(q))) return true;
    if (r.output && typeof r.output === 'object') {
      for (const f of outputFields || []) {
        const val = r.output[f.key];
        if (val != null && String(val).toLowerCase().includes(q)) return true;
        if (Array.isArray(val) && val.some((v) => String(v).toLowerCase().includes(q))) return true;
      }
    }
    return false;
  });
}

/**
 * Resume 时合并已有结果与新结果。
 * @param {Array} existing - 已有结果
 * @param {Array} newResults - 新批次结果（row_index/input_row_index 为批次内相对值）
 * @param {number} inputRowOffset - 输入行偏移（nextRowIndex），用于 input_row_index
 * @param {number} rowIndexOffset - 展示行偏移（通常 = existing.length），用于 row_index 保证序号连续
 */
function mergeResumeResults(existing, newResults, inputRowOffset, rowIndexOffset) {
  if (!Array.isArray(existing)) existing = [];
  if (!Array.isArray(newResults)) newResults = [];
  const rOffset = typeof rowIndexOffset === 'number' ? rowIndexOffset : existing.length;
  const iOffset = typeof inputRowOffset === 'number' ? inputRowOffset : 0;
  const adjusted = newResults.map((r) => ({
    ...r,
    row_index: (r.row_index ?? 0) + rOffset,
    input_row_index: (r.input_row_index ?? r.row_index ?? 0) + iOffset,
  }));
  const byIndex = new Map();
  existing.forEach((r) => byIndex.set(r.row_index ?? -1, r));
  adjusted.forEach((r) => byIndex.set(r.row_index ?? -1, r));
  const merged = Array.from(byIndex.values()).filter((r) => (r.row_index ?? -1) >= 0);
  merged.sort((a, b) => (a.row_index ?? 0) - (b.row_index ?? 0));
  return merged;
}

/** 第一个未完成的 input 行索引（0-based）。用 input_row_index 判断哪些 input 行已有结果；无则回退到 row_index。 */
function getNextRowIndex(results, totalRows) {
  if (!Array.isArray(results) || results.length === 0) return 0;
  const done = new Set(results.map((x) => (x.input_row_index ?? x.row_index ?? -1)).filter((i) => i >= 0));
  let i = 0;
  while (i < totalRows && done.has(i)) i++;
  return i;
}

// ---

export function openRunDetailModal({
  node,
  getWorkingSets = () => [],
  getPromptInputFields = () => [],
  getSubsetContent = () => ({ headers: [], rows: [] }),
  getPromptTemplate = () => ({ sections: [], outputSchema: { return_shape: 'single', fields: [] } }),
  registerPendingRun = () => {},
  unregisterPendingRun = () => {},
  getPendingRunId = () => null,
  getPromptName = () => '',
  getUniqueDatasetExportName = (n) => n,
  isRunNameAlreadyUsedForPrompt = () => false,
  getRunMappingsFromCanvas,
}) {
  // 从画布其他 Run 节点恢复列映射记忆
  (getRunMappingsFromCanvas?.() || []).forEach((parsed) => {
    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([inputName, columnName]) => {
        if (inputName != null && String(columnName || '').trim()) inputNameToColumnMemory[inputName] = String(columnName).trim();
      });
    }
  });

  const inputFields = getPromptInputFields();
  let selectedNodeId = (node?.dataset?.runWorkingSetId || '').trim();
  let selectedCredentialId = (node?.dataset?.runCredentialId || '').trim();
  const runName = (node?.dataset?.runName || node?.querySelector?.('.workflow-node__title')?.textContent?.trim() || 'Run').trim() || 'Run';
  const nodeId = node?.dataset?.nodeId || '';

  let runId = getPendingRunId() || null; // 发起运行后得到的 run_id；打开时若有进行中的 run 则从 pendingRuns 恢复
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
  let inputToColumn = {};
  try {
    const raw = node?.dataset?.runInputToColumn;
    if (raw) {
      const o = JSON.parse(raw);
      inputToColumn = typeof o === 'object' && o !== null ? o : {};
    }
  } catch (_) {}

  // --- DOM 结构（界面不变）---

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'run-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--run-detail">
      <div class="modal-header">
        <h2 id="run-detail-title" class="modal-title">${escapeHtml(`Run: ${runName}`)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body run-detail-body modal-body--run">
        <div class="run-detail-main">
          <p class="run-detail-main-label">Run settings</p>
          <div class="dataset-meta-wrap run-detail-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="run-detail-ws-picker">Input dataset</label>
              <div class="run-detail-ws-picker" id="run-detail-ws-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Select input dataset">
                <div class="run-detail-ws-trigger" tabindex="0">
                  <span class="run-detail-ws-trigger-color" id="run-detail-ws-trigger-color"></span>
                  <span class="run-detail-ws-trigger-text" id="run-detail-ws-trigger-text">— Select input dataset —</span>
                  <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                </div>
                <div class="run-detail-ws-dropdown" id="run-detail-ws-dropdown" role="listbox" hidden></div>
              </div>
            </div>
            <div class="run-detail-inputs-section dataset-meta-field" id="run-detail-inputs-section">
              <span class="dataset-meta-label run-detail-section-label">Map input dataset columns to prompt inputs</span>
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
            <button type="button" class="btn btn-primary run-detail-run-btn" disabled>Run</button>
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
  const workingSets = getWorkingSets();

  // --- 节点状态读写 ---

  function getNodeResults() {
    try {
      const r = node?.dataset?.runResults;
      const f = node?.dataset?.runOutputFields;
      if (!r || !f) return { results: [], outputFields: [] };
      const results = JSON.parse(r);
      const outputFields = JSON.parse(f);
      return { results: Array.isArray(results) ? results : [], outputFields: Array.isArray(outputFields) ? outputFields : [] };
    } catch (_) { return { results: [], outputFields: [] }; }
  }

  function isCompleted() { return node?.dataset?.runCompleted === '1'; }

  /** 正在运行中（generating 状态） */
  function isRunning() { return !!(runId || resultsState.status === 'generating'); }

  function setNodeProgressBar(completed, total) {
    const bar = node?.querySelector('.workflow-node__run-progress');
    if (!bar) return;
    const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  }

  function writeNodeRunState({ results, outputFields, completed, total, runCompleted }) {
    if (!node) return;
    try {
      if (results != null) node.dataset.runResults = JSON.stringify(results);
      if (outputFields != null) node.dataset.runOutputFields = JSON.stringify(outputFields);
      if (runCompleted !== undefined) node.dataset.runCompleted = runCompleted ? '1' : '';
    } catch (_) {}
    if (completed != null && total != null) setNodeProgressBar(completed, total);
  }

  // --- 按钮状态：Run | Resume | Running | Run completed ---

  function applyRunningLock() {
    runBtn.disabled = true;
    runBtn.textContent = 'Running';
    runBtn.classList.remove('btn-primary', 'btn-danger');
    runBtn.classList.add('btn-secondary');
    runBtn.setAttribute('aria-label', 'Running');
    llmSelectEl.disabled = true;
    pickerEl.classList.add('run-detail-ws-picker--locked');
    pickerEl.setAttribute('aria-disabled', 'true');
    inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
    overlay.querySelector('.run-detail-main')?.classList.add('run-detail-main--locked');
  }

  function applyUnlock() {
    llmSelectEl.disabled = false;
    pickerEl.classList.remove('run-detail-ws-picker--locked');
    pickerEl.removeAttribute('aria-disabled');
    inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = false; });
    overlay.querySelector('.run-detail-main')?.classList.remove('run-detail-main--locked');
  }

  function refreshButton() {
    if (isCompleted()) {
      applyCompletedLock();
      return;
    }
    if (isRunning()) {
      applyRunningLock();
      return;
    }
    applyUnlock();
    const { results } = getNodeResults();
    runBtn.classList.remove('btn-danger');
    runBtn.classList.add('btn-primary');
    runBtn.textContent = results.length > 0 ? 'Resume' : 'Run';
    runBtn.disabled = !(selectedNodeId && selectedCredentialId);
  }

  function applyCompletedLock() {
    if (!isCompleted()) return;
    runBtn.disabled = true;
    runBtn.textContent = 'Run completed';
    runBtn.setAttribute('aria-label', 'Run completed');
    runBtn.classList.remove('btn-primary', 'btn-danger');
    runBtn.classList.add('btn-secondary');
    llmSelectEl.disabled = true;
    pickerEl.classList.add('run-detail-ws-picker--locked');
    pickerEl.setAttribute('aria-disabled', 'true');
    inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
    overlay.querySelector('.run-detail-main')?.classList.add('run-detail-main--locked');
  }

  // --- 右侧结果展示 ---

  function expandRightPanel() {
    if (runDetailPanel && !runDetailPanel.classList.contains('run-detail-panel--expanded')) runDetailPanel.classList.add('run-detail-panel--expanded');
  }

  function showResults(results, outputFields, status, placeholderText) {
    resultsState.results = results || [];
    resultsState.outputFields = outputFields || [];
    resultsState.workingContent = getSubsetContent(selectedNodeId) || null;
    resultsState.status = status || 'complete';
    rightCol.innerHTML = '';
    if (!resultsState.results.length) {
      const card = document.createElement('div');
      card.className = 'run-detail-results-card';
      const wrap = document.createElement('div');
      wrap.className = 'run-detail-results';
      wrap.innerHTML = `<p class="run-detail-placeholder">${escapeHtml(placeholderText || 'Run to see results.')}</p>`;
      card.appendChild(wrap);
      rightCol.appendChild(card);
    } else {
      rightCol.appendChild(buildResultsCard(resultsState.results, resultsState.outputFields, resultsState.status));
    }
    expandRightPanel();
  }

  function buildResultsTable(results, outputFields, workingContent, bracketColsCollapsed, onToggleCollapse) {
    const wsHeaders = (workingContent?.headers) || [];
    const wsRows = (workingContent?.rows) || [];
    const collapsed = !!bracketColsCollapsed;
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
    if (wsHeaders.length >= 0) {
      const thBracket = document.createElement('th');
      thBracket.className = 'run-detail-th run-detail-th--dataset-row-col run-detail-th--bracket-toggle';
      thBracket.textContent = collapsed ? '...' : 'Input: #';
      thBracket.title = collapsed ? 'Click to expand.' : 'Click to collapse.';
      thBracket.setAttribute('role', 'button');
      thBracket.setAttribute('tabindex', '0');
      if (typeof onToggleCollapse === 'function') {
        thBracket.addEventListener('click', onToggleCollapse);
        thBracket.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse(); } });
      }
      headerRow.appendChild(thBracket);
      if (!collapsed) wsHeaders.forEach((h) => {
        const th = document.createElement('th');
        th.className = 'run-detail-th run-detail-th--dataset-row-col';
        th.textContent = `Input: ${String(h ?? '').trim() || ' '}`;
        headerRow.appendChild(th);
      });
    }
    thead.appendChild(headerRow);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    results.forEach((r) => {
      const tr = document.createElement('tr');
      tr.appendChild(Object.assign(document.createElement('td'), { className: 'run-detail-td run-detail-td--index', textContent: String(r.row_index + 1) }));
      if (r.error) {
        outputFields.forEach(() => {
          const td = document.createElement('td');
          td.className = 'run-detail-td run-detail-td--error';
          td.textContent = truncate(r.error);
          td.title = r.error ?? '';
          tr.appendChild(td);
        });
      } else {
        outputFields.forEach((f) => {
          const td = document.createElement('td');
          td.className = 'run-detail-td';
          const val = r.output?.[f.key];
          if (val == null) td.textContent = '—';
          else if (Array.isArray(val)) { td.textContent = truncate(val.join(', ')); td.title = val.join(', '); }
          else { td.textContent = truncate(String(val)); td.title = String(val); }
          tr.appendChild(td);
        });
      }
      if (wsHeaders.length >= 0) {
        if (collapsed) {
          const td = document.createElement('td');
          td.className = 'run-detail-td run-detail-td--dataset-row-col';
          td.textContent = '...';
          tr.appendChild(td);
        } else {
          const inpIdx = r.input_row_index ?? r.row_index ?? 0;
          tr.appendChild(Object.assign(document.createElement('td'), { className: 'run-detail-td run-detail-td--dataset-row-col', textContent: String(inpIdx + 1) }));
          const wsRow = Array.isArray(wsRows[inpIdx]) ? wsRows[inpIdx] : [];
          wsHeaders.forEach((_, i) => {
            const td = document.createElement('td');
            td.className = 'run-detail-td run-detail-td--dataset-row-col';
            const v = wsRow[i];
            td.textContent = v == null ? '—' : truncate(String(v));
            if (v != null) td.title = String(v);
            tr.appendChild(td);
          });
        }
      }
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    return tbl;
  }

  function buildResultsCard(results, outputFields, status) {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';
    const statusNote = document.createElement('span');
    statusNote.className = `run-detail-results-note run-detail-results-note--inline run-detail-results-note--${status === 'generating' ? 'generating' : status === 'complete' ? 'complete' : 'incomplete'}`;
    statusNote.textContent = STATUS_TEXT[status] || '';
    const topRow = document.createElement('div');
    topRow.className = 'run-detail-results-top-row';
    topRow.appendChild(statusNote);
    const searchWrap = document.createElement('div');
    searchWrap.className = 'dataset-detail-preview-search-wrap run-detail-results-search-wrap';
    searchWrap.innerHTML = `<label class="dataset-detail-search-label" for="run-detail-results-search">Search</label><input type="text" id="run-detail-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" />`;
    topRow.appendChild(searchWrap);
    wrap.appendChild(topRow);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'run-detail-results-table-wrap';
    wrap.appendChild(tableWrap);
    const toolbar = document.createElement('div');
    toolbar.className = 'dataset-detail-preview-toolbar run-detail-results-toolbar';
    toolbar.innerHTML = `
      <label class="dataset-detail-rows-label" for="run-detail-rows-per-page">Rows per page</label>
      <select id="run-detail-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === resultsState.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}</select>
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

    function refreshTable() {
      const filtered = filterResults(resultsState.results, resultsState.outputFields, resultsState.searchQuery, resultsState.workingContent);
      const totalPages = Math.max(1, Math.ceil(filtered.length / resultsState.rowsPerPage));
      resultsState.currentPage = Math.min(Math.max(1, resultsState.currentPage), totalPages);
      const start = (resultsState.currentPage - 1) * resultsState.rowsPerPage;
      const pageResults = filtered.slice(start, start + resultsState.rowsPerPage);
      const onToggle = () => {
        resultsState.bracketColsCollapsed = !resultsState.bracketColsCollapsed;
        if (node) node.dataset.runBracketColsCollapsed = resultsState.bracketColsCollapsed ? '1' : '0';
        refreshTable();
      };
      tableWrap.innerHTML = '';
      tableWrap.appendChild(buildResultsTable(pageResults, resultsState.outputFields, resultsState.workingContent, resultsState.bracketColsCollapsed, onToggle));
      const totalFiltered = filtered.length;
      const totalRows = resultsState.results.length;
      paginationInfo.textContent = totalFiltered === 0 ? (totalRows === 0 ? '0 rows' : `0 rows (filtered from ${totalRows.toLocaleString()})`) : (totalFiltered === totalRows ? `Showing ${start + 1}–${Math.min(start + resultsState.rowsPerPage, totalFiltered)} of ${totalRows.toLocaleString()} rows` : `Showing ${start + 1}–${Math.min(start + resultsState.rowsPerPage, totalFiltered)} of ${totalFiltered.toLocaleString()} (filtered from ${totalRows.toLocaleString()}) rows`);
      pageInp.value = String(resultsState.currentPage);
      pageInp.max = String(totalPages);
      pageOfSpan.textContent = `/ ${totalPages}`;
      prevBtn.disabled = resultsState.currentPage <= 1;
      nextBtn.disabled = resultsState.currentPage >= totalPages;
    }

    const searchInp = wrap.querySelector('#run-detail-results-search');
    searchInp.addEventListener('input', () => { resultsState.searchQuery = searchInp.value; resultsState.currentPage = 1; refreshTable(); });
    rowsPerPageSelect.addEventListener('change', () => { resultsState.rowsPerPage = Number(rowsPerPageSelect.value) || 25; resultsState.currentPage = 1; refreshTable(); });
    pageInp.addEventListener('change', () => { resultsState.currentPage = Math.max(1, parseInt(pageInp.value, 10) || 1); refreshTable(); });
    prevBtn.addEventListener('click', () => { resultsState.currentPage = Math.max(1, resultsState.currentPage - 1); refreshTable(); });
    nextBtn.addEventListener('click', () => {
      const filtered = filterResults(resultsState.results, resultsState.outputFields, resultsState.searchQuery, resultsState.workingContent);
      resultsState.currentPage = Math.min(Math.ceil(filtered.length / resultsState.rowsPerPage), resultsState.currentPage + 1);
      refreshTable();
    });
    wrap._updateResultsTable = refreshTable;
    refreshTable();

    const footer = document.createElement('div');
    footer.className = 'run-detail-results-footer';
    footer.appendChild(toolbar);
    const footerActions = document.createElement('div');
    footerActions.className = 'run-detail-results-footer-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary run-detail-save-to-workspace-btn';
    saveBtn.textContent = 'Save to workspace';
    saveBtn.addEventListener('click', () => {
      const promptName = (getPromptName() || '').trim() || 'Prompt';
      const baseName = `${promptName} ${runName}`.trim();
      const datasetName = getUniqueDatasetExportName(baseName);
      const wc = resultsState.workingContent || { headers: [], rows: [] };
      const outputHeaders = (resultsState.outputFields || []).map((f) => (f.display || f.key || '').trim() || 'output');
      const inputHeaders = (wc.headers || []).map((h) => 'Input: ' + (String(h ?? '').trim() || ' '));
      const rows = (resultsState.results || []).map((r) => {
        const outputPart = r.error ? (resultsState.outputFields || []).map(() => String(r.error)) : (resultsState.outputFields || []).map((f) => { const v = r.output?.[f.key]; return v == null ? '—' : Array.isArray(v) ? v.join(', ') : String(v); });
        const inpIdx = r.input_row_index ?? r.row_index ?? 0;
        const inputRow = (wc.rows || [])[inpIdx] || [];
        const inputPart = (wc.headers || []).map((_, i) => (inputRow[i] == null ? '—' : String(inputRow[i])));
        return [...outputPart, ...inputPart];
      });
      document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', { detail: { name: datasetName, notes: `Exported from ${promptName} ${runName}.\n${resultsState.status === 'complete' ? 'Run completed.' : 'Run incomplete.'}`, headers: [...outputHeaders, ...inputHeaders], rows } }));
      closeModal();
    });
    const scoreBtn = document.createElement('button');
    scoreBtn.type = 'button';
    scoreBtn.className = 'btn btn-primary run-detail-save-to-workspace-score-btn';
    scoreBtn.textContent = 'Score';
    scoreBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('workflow:add-score-node', { detail: { runNodeId: node?.dataset?.nodeId || '' } }));
      closeModal();
    });
    footerActions.append(saveBtn, scoreBtn);
    footer.appendChild(footerActions);
    wrap.appendChild(footer);
    card.appendChild(wrap);
    card._updateResults = () => wrap._updateResultsTable?.();
    return card;
  }

  // --- 左侧：数据集选择、列映射、模型选择 ---

  function getSelectedWorkingSet() {
    return workingSets.find((ws) => ws.nodeId === selectedNodeId) || null;
  }

  function updateRunNodeBorder() {
    const ws = getSelectedWorkingSet();
    if (node?.style) {
      node.style.borderColor = ws?.color || '';
      node.dataset.runWorkingSetId = selectedNodeId || '';
      const bar = node.querySelector('.workflow-node__run-progress');
      if (bar) bar.style.background = ws?.color || bar.style.background;
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
      triggerTextEl.textContent = '— Select input dataset —';
    }
  }

  function selectWorkingSet(id) {
    selectedNodeId = id || '';
    updateTriggerDisplay();
    updateRunNodeBorder();
    dropdownEl.hidden = true;
    pickerEl.setAttribute('aria-expanded', 'false');
    dropdownEl.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', o.dataset.nodeId === selectedNodeId ? 'true' : 'false'));
    renderInputMappings();
    refreshButton();
  }

  function populateDropdown() {
    dropdownEl.innerHTML = '';
    const add = (nid, label) => {
      const opt = document.createElement('div');
      opt.className = 'run-detail-ws-option';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', nid === selectedNodeId ? 'true' : 'false');
      opt.dataset.nodeId = nid;
      opt.innerHTML = nid ? `<span class="run-detail-ws-option-color" style="background:${escapeHtml(workingSets.find((w) => w.nodeId === nid)?.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(label)}</span>` : '<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">— Select input dataset —</span>';
      opt.addEventListener('click', () => selectWorkingSet(nid));
      dropdownEl.appendChild(opt);
    };
    add('', '');
    workingSets.forEach((ws) => add(ws.nodeId, ws.name || 'Dataset'));
  }

  function renderInputMappings() {
    const content = selectedNodeId ? getSubsetContent(selectedNodeId) : null;
    const ws = getSelectedWorkingSet();
    const headers = (content?.headers || ws?.headers || []).slice();
    const headerSet = new Set(headers);
    inputsListEl.innerHTML = '';
    if (inputFields.length === 0) { inputsListEl.innerHTML = '<p class="run-detail-placeholder">No prompt inputs.</p>'; return; }
    inputFields.forEach((inputName) => {
      let col = inputToColumn[inputName] || '';
      if (col && !headerSet.has(col)) { col = ''; inputToColumn[inputName] = ''; if (node) try { node.dataset.runInputToColumn = JSON.stringify(inputToColumn); } catch (_) {} }
      if (!col && inputNameToColumnMemory[inputName] && headerSet.has(inputNameToColumnMemory[inputName])) { col = inputNameToColumnMemory[inputName]; inputToColumn[inputName] = col; if (node) try { node.dataset.runInputToColumn = JSON.stringify(inputToColumn); } catch (_) {} }
    });
    const table = document.createElement('div');
    table.className = 'run-detail-mapping-table';
    table.setAttribute('role', 'table');
    table.innerHTML = `<div class="run-detail-mapping-head" role="row"><span class="run-detail-mapping-th run-detail-mapping-th--column" role="columnheader">Dataset column</span><span class="run-detail-mapping-th run-detail-mapping-th--arrow" aria-hidden="true">→</span><span class="run-detail-mapping-th run-detail-mapping-th--input" role="columnheader">Prompt input</span></div>`;
    inputFields.forEach((inputName) => {
      const row = document.createElement('div');
      row.className = 'run-detail-mapping-row';
      row.setAttribute('role', 'row');
      const currentCol = inputToColumn[inputName] || '';
      row.innerHTML = `<span class="run-detail-mapping-cell run-detail-mapping-cell--column" role="cell"><select class="run-detail-column-select" data-input="${escapeAttr(inputName)}" aria-label="Dataset column for ${escapeAttr(inputName)}"><option value="">— Select column —</option>${headers.map((h) => `<option value="${escapeAttr(h)}" ${h === currentCol ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}</select></span><span class="run-detail-mapping-cell run-detail-mapping-cell--arrow" aria-hidden="true">→</span><span class="run-detail-mapping-cell run-detail-mapping-cell--input" role="cell">${escapeHtml(inputName)}</span>`;
      row.querySelector('.run-detail-column-select').addEventListener('change', (e) => {
        inputToColumn[inputName] = (e.target.value || '').trim() || '';
        if (node) try { node.dataset.runInputToColumn = JSON.stringify(inputToColumn); } catch (_) {}
      });
      table.appendChild(row);
    });
    inputsListEl.appendChild(table);
  }

  // --- 轮询更新：workflow:run-results-updated ---

  function onRunResultsUpdated(e) {
    if (e.detail?.nodeId !== nodeId) return;
    let { results, outputFields, isComplete, cancelled } = e.detail;
    if (isComplete) runId = null;
    if (isComplete && !cancelled && node) node.dataset.runCompleted = '1';
    if (!Array.isArray(results)) return;
    if (!Array.isArray(outputFields) || outputFields.length === 0) {
      outputFields = getNodeResults().outputFields;
    }
    if (outputFields.length === 0 && results.length > 0 && results[0].output && typeof results[0].output === 'object') {
      outputFields = Object.keys(results[0].output).map((k) => ({ key: k, display: k }));
    }
    const status = isComplete ? 'complete' : 'generating';
    resultsState.results = results;
    resultsState.outputFields = outputFields;
    resultsState.workingContent = getSubsetContent(selectedNodeId) || null;
    resultsState.status = status;
    resultsState.currentPage = 1;
    rightCol.innerHTML = '';
    rightCol.appendChild(buildResultsCard(results, outputFields, status));
    expandRightPanel();
    if (isComplete) applyCompletedLock(); else refreshButton();
  }

  function closeModal() {
    document.removeEventListener('workflow:run-results-updated', onRunResultsUpdated);
    overlay.remove();
    document.body.style.overflow = '';
  }

  // --- 事件绑定 ---

  document.addEventListener('workflow:run-results-updated', onRunResultsUpdated);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);

  triggerEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (isCompleted() || isRunning()) return;
    if (dropdownEl.hidden) { populateDropdown(); dropdownEl.hidden = false; pickerEl.setAttribute('aria-expanded', 'true'); }
    else { dropdownEl.hidden = true; pickerEl.setAttribute('aria-expanded', 'false'); }
  });
  triggerEl.addEventListener('keydown', (e) => {
    if (isCompleted() || isRunning()) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (dropdownEl.hidden) { populateDropdown(); dropdownEl.hidden = false; pickerEl.setAttribute('aria-expanded', 'true'); }
      else { dropdownEl.hidden = true; pickerEl.setAttribute('aria-expanded', 'false'); }
    }
  });
  overlay.addEventListener('click', (e) => { if (!pickerEl.contains(e.target)) { dropdownEl.hidden = true; pickerEl.setAttribute('aria-expanded', 'false'); } });

  (async () => {
    llmSelectEl.innerHTML = '<option value="">— Select model for prompt —</option>';
    try {
      const res = await fetch(`${API_BASE}/api/credentials`);
      if (!res.ok) return;
      const list = await res.json();
      list.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name || c.llm || c.id; llmSelectEl.appendChild(o); });
      if (selectedCredentialId) llmSelectEl.value = selectedCredentialId;
    } catch (e) { console.error('Load credentials:', e); }
  })();
  llmSelectEl.addEventListener('change', () => {
    selectedCredentialId = (llmSelectEl.value || '').trim();
    if (node) node.dataset.runCredentialId = selectedCredentialId || '';
    refreshButton();
  });

  // --- 点击 Run / Resume ---

  runBtn.addEventListener('click', async () => {
    if (isCompleted()) return;
    if (runId) return;
    if (!selectedNodeId || !selectedCredentialId) return;

    const content = getSubsetContent(selectedNodeId);
    const template = getPromptTemplate();
    const headers = content?.headers || [];
    const rows = content?.rows || [];

    if (rows.length === 0) {
      showResults([], [], 'complete', 'Dataset has no rows.');
      return;
    }
    const templateText = (template.sections || []).map((s) => (s.content || '').trim()).filter(Boolean).join('\n\n');
    if (!templateText) {
      showResults([], [], 'complete', 'Prompt has no content.');
      return;
    }
    const outputSchema = { return_shape: template.outputSchema?.return_shape || 'single', fields: (template.outputSchema?.fields || []).map((f) => ({ key: f.key, type: f.type || 'str', description: f.description, allow_none: f.allowNone ?? f.allow_none ?? false })) };
    if (!outputSchema.fields.length) {
      showResults([], [], 'complete', 'Prompt output schema has no fields.');
      return;
    }

    const { results: existingResults, outputFields: existingFields } = getNodeResults();
    const nextRowIndex = getNextRowIndex(existingResults, rows.length);
    const rowsToRun = rows.slice(nextRowIndex);

    if (rowsToRun.length === 0) {
      if (node && existingResults.length > 0) writeNodeRunState({ results: existingResults, outputFields: existingFields, completed: rows.length, total: rows.length, runCompleted: true });
      showResults(existingResults, existingFields, 'complete', 'All rows already completed.');
      refreshButton();
      return;
    }

    const buildPrompts = (rowList) => rowList.map((row) => {
      let text = templateText;
      inputFields.forEach((inputName) => {
        const col = inputToColumn[inputName];
        const idx = headers.indexOf(col);
        const val = idx >= 0 ? (row[idx] ?? '') : '';
        text = text.replace(new RegExp('\\{' + escapeRegex(inputName) + '\\}', 'g'), String(val));
      });
      return text;
    });
    const prompts = buildPrompts(rowsToRun);

    if (node) {
      if (nextRowIndex === 0) {
        writeNodeRunState({ results: [], outputFields: [], completed: 0, total: rows.length, runCompleted: false });
        const bar = node.querySelector('.workflow-node__run-progress');
        if (bar) bar.style.width = '0%';
        delete node.dataset.runResumeStartIndex;
        delete node.dataset.runResumeExistingResults;
        delete node.dataset.runResumeTotalRows;
      } else {
        node.dataset.runResumeStartIndex = String(nextRowIndex);
        node.dataset.runResumeExistingResults = node.dataset.runResults || '[]';
        node.dataset.runResumeTotalRows = String(rows.length);
      }
    }

    showResults(existingResults, existingFields, 'generating', nextRowIndex > 0 ? 'Resuming…' : 'Running…');
    applyRunningLock();

    try {
      const res = await fetch(`${API_BASE}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential_id: selectedCredentialId, prompts, output_schema: outputSchema, run_node_id: nodeId || null }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        runId = data.run_id || null;
        if (runId && nodeId) registerPendingRun(nodeId, runId);
        refreshButton();
        return;
      }
      if (!res.ok) {
        runId = null;
        resultsState.status = 'complete';
        if (nextRowIndex > 0) {
          delete node?.dataset?.runResumeStartIndex;
          delete node?.dataset?.runResumeExistingResults;
          delete node?.dataset?.runResumeTotalRows;
        }
        rightCol.innerHTML = `<p class="run-detail-error">${escapeHtml(data.detail || res.statusText || 'Request failed')}</p>`;
        expandRightPanel();
        refreshButton();
        return;
      }
      let results = data.results || [];
      const outputFields = data.output_fields || [];
      if (nextRowIndex > 0 && existingResults.length > 0) {
        results = mergeResumeResults(existingResults, results, nextRowIndex, existingResults.length);
      }
      runId = null;
      if (node && nextRowIndex > 0) {
        delete node.dataset.runResumeStartIndex;
        delete node.dataset.runResumeExistingResults;
        delete node.dataset.runResumeTotalRows;
      }
      writeNodeRunState({ results, outputFields, completed: rows.length, total: rows.length, runCompleted: true });
      showResults(results, outputFields, 'complete');
    } catch (e) {
      runId = null;
      resultsState.status = 'complete';
      if (nextRowIndex > 0 && node) {
        delete node.dataset.runResumeStartIndex;
        delete node.dataset.runResumeExistingResults;
        delete node.dataset.runResumeTotalRows;
      }
      rightCol.innerHTML = `<p class="run-detail-error">${escapeHtml(String(e.message || e))}</p>`;
      expandRightPanel();
    }
    refreshButton();
  });

  // --- 初始化：不自动运行，不自动恢复 ---

  updateTriggerDisplay();
  updateRunNodeBorder();
  renderInputMappings();
  refreshButton();
  if (isCompleted()) applyCompletedLock();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  // 右侧：显示上次保存的结果（如有）
  rightCol.innerHTML = '';
  try {
    const savedResults = node?.dataset?.runResults;
    const savedFields = node?.dataset?.runOutputFields;
    if (savedResults && savedFields) {
      const results = JSON.parse(savedResults);
      const outputFields = JSON.parse(savedFields);
      if (Array.isArray(results) && Array.isArray(outputFields)) {
        const pct = node?.querySelector('.workflow-node__run-progress')?.getAttribute('aria-valuenow');
        const status = runId ? 'generating' : (pct === '100' ? 'complete' : 'incomplete');
        resultsState.results = results;
        resultsState.outputFields = outputFields;
        resultsState.workingContent = getSubsetContent(selectedNodeId) || null;
        resultsState.status = status;
        rightCol.appendChild(buildResultsCard(results, outputFields, status));
        expandRightPanel();
      }
    }
  } catch (_) {}
  if (!rightCol.firstChild) {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    card.innerHTML = `<div class="run-detail-results"><p class="run-detail-placeholder">${runId ? 'Running…' : 'Run to see results.'}</p></div>`;
    rightCol.appendChild(card);
  }
}
