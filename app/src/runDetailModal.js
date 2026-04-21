/**
 * Run 节点详情弹窗
 *
 * 选数据集、列映射、模型 → Run / Resume → 右侧表格显示结果
 * input_row_index 统一 0-based，展示时 +1
 */

import { getNextRowIndex, mergeResumeResults, embedInputRow, processApiResults, markEmptyOutputAsError } from './runResumeUtils.js';
import { selectPlaceholderLabel, formatResultOutputColumnLabel } from './displayTextNormalize.js';
import { attachModalPaneToggle } from './paneToggleButton.js';

const API_BASE = 'http://localhost:8000';
const MAX_CELL_CHARS = 40;
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];
const STATUS_TEXT = {
  generating: 'Results are still generating…',
  complete: 'Results complete.',
  incomplete: 'Last run did not complete.',
};

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

/** Same order as buildResultsTable historically used: input row, then run row # */
function sortRunResultsRows(a, b) {
  const ai = a.input_row_index ?? 0;
  const bi = b.input_row_index ?? 0;
  if (ai !== bi) return ai - bi;
  return (a.row_index ?? 0) - (b.row_index ?? 0);
}

/** Zebra band per dataset input: rows sharing input_row_index share one stripe; stripe flips when input changes in sort order */
function buildZebraMapForInputGroups(sortedRows) {
  const map = new Map();
  if (!sortedRows.length) return map;
  let stripe = 0;
  let prevKey;
  for (const r of sortedRows) {
    const k = r.input_row_index ?? 0;
    if (prevKey !== undefined && k !== prevKey) stripe = 1 - stripe;
    prevKey = k;
    map.set(k, stripe);
  }
  return map;
}

function filterResults(results, outputFields, searchQuery, inputColsCollapsed = false, outputColsCollapsed = false) {
  const q = (searchQuery || '').trim().toLowerCase();
  if (!q) return results;
  return results.filter((r) => {
    if (inputColsCollapsed && 'input ...'.includes(q)) return true;
    if (outputColsCollapsed && 'output ...'.includes(q)) return true;
    if (String((r.input_row_index ?? 0) + 1).toLowerCase().includes(q)) return true;
    if (String((r.row_index ?? 0) + 1).toLowerCase().includes(q)) return true;
    if (r.error && String(r.error).toLowerCase().includes(q)) return true;
    const inputRow = Array.isArray(r.input_row) ? r.input_row : [];
    if (inputRow.some((v) => v != null && String(v).toLowerCase().includes(q))) return true;
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

function _sanitizeFieldName(key) {
  const s = String(key ?? '').trim().replace(/[^\w]/g, '_');
  return s || 'field';
}

export function deriveOutputFields(results, schemaFields) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const first = results.find((r) => r.output && typeof r.output === 'object');
  if (!first) return [];
  const schema = Array.isArray(schemaFields) ? schemaFields : [];
  const schemaBySanitized = new Map();
  schema.forEach((f) => {
    const k = (f.key || '').trim();
    if (k) schemaBySanitized.set(_sanitizeFieldName(k), k);
  });
  return Object.keys(first.output).map((outputKey) => ({
    key: outputKey,
    display: schemaBySanitized.get(outputKey) || outputKey,
  }));
}

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

  let runId = getPendingRunId() || null;
  const resultsState = {
    results: [],
    outputFields: [],
    inputHeaders: [],
    status: 'complete',
    searchQuery: '',
    rowsPerPage: 25,
    currentPage: 1,
    bracketColsCollapsed: node?.dataset?.runBracketColsCollapsed !== '0',
    outputBracketCollapsed: node?.dataset?.runOutputBracketCollapsed === '1',
  };
  let inputToColumn = {};
  try {
    const raw = node?.dataset?.runInputToColumn;
    if (raw) {
      const o = JSON.parse(raw);
      inputToColumn = typeof o === 'object' && o !== null ? o : {};
    }
  } catch (_) {}

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
                  <span class="run-detail-ws-trigger-text" id="run-detail-ws-trigger-text">${escapeHtml(selectPlaceholderLabel('Select input dataset'))}</span>
                  <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                </div>
                <div class="run-detail-ws-dropdown" id="run-detail-ws-dropdown" role="listbox" hidden></div>
              </div>
            </div>
            <div class="run-detail-inputs-section dataset-meta-field" id="run-detail-inputs-section">
              <span class="dataset-meta-label run-detail-section-label">Map input dataset columns to prompt inputs</span>
              <div class="run-detail-mapping-wrap" id="run-detail-inputs-list"></div>
            </div>
          </div>
          <div class="prompt-form-error prompt-modal-error run-detail-form-error" id="run-detail-form-error" role="alert" aria-live="polite" hidden></div>
          <div class="dataset-meta-field run-detail-model-actions-field">
            <div class="run-detail-llm-actions-row">
              <span class="run-detail-llm-actions-lead" aria-hidden="true"></span>
              <div class="run-detail-llm-actions-right">
                <div class="run-detail-llm-row">
                  <select id="run-detail-llm-select" class="run-detail-llm-select dataset-meta-input" aria-label="Select model">
                    <option value="">${escapeHtml(selectPlaceholderLabel('Select model'))}</option>
                  </select>
                </div>
                <button type="button" class="btn btn-primary run-detail-run-btn" disabled>Run</button>
              </div>
            </div>
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
  const workingSets = getWorkingSets();

  function getNodeResults() {
    const r = node?.dataset?.runResults;
    if (!r || typeof r !== 'string') return { results: [], outputFields: [] };
    let results;
    try {
      results = JSON.parse(r);
    } catch (e) {
      console.warn('[Run] getNodeResults: JSON.parse failed', e?.message || e);
      return { results: [], outputFields: [] };
    }
    if (!Array.isArray(results)) return { results: [], outputFields: [] };
    let content = null;
    if (node?.dataset?.runInputContent) {
      try { content = JSON.parse(node.dataset.runInputContent); } catch (_) {}
    }
    if (!content && selectedNodeId) content = getSubsetContent(selectedNodeId);
    if (content) results = embedInputRow(results, content);
    results = markEmptyOutputAsError(results);
    let outputFields = [];
    try {
      const schemaFields = getPromptTemplate()?.outputSchema?.fields || [];
      outputFields = deriveOutputFields(results, schemaFields);
    } catch (e) {
      console.warn('[Run] deriveOutputFields failed', e?.message || e);
    }
    if (outputFields.length === 0 && results.length > 0 && results.some((x) => x.error)) {
      outputFields = [{ key: 'error', display: 'Error' }];
    }
    if (outputFields.length === 0 && results.length > 0) {
      const first = results.find((x) => x.output && typeof x.output === 'object' && Object.keys(x.output).length > 0);
      if (first) outputFields = Object.keys(first.output).map((k) => ({ key: k, display: k }));
    }
    if (outputFields.length === 0 && results.length > 0) {
      const schemaFields = getPromptTemplate()?.outputSchema?.fields || [];
      if (schemaFields.length > 0) outputFields = schemaFields.map((f) => ({ key: (f.key || '').trim() || 'field', display: (f.display || f.key || '').trim() || 'field' })).filter((f) => f.key);
    }
    return { results, outputFields };
  }

  function isCompleted() { return node?.dataset?.runCompleted === '1'; }
  function isRunning() { return !!(runId || resultsState.status === 'generating'); }

  function setNodeProgressBar(completed, total) {
    const bar = node?.querySelector('.workflow-node__run-progress');
    if (!bar) return;
    const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  }

  function writeNodeRunState({ results, completed, total, runCompleted }) {
    if (!node) return;
    try {
      if (results != null) node.dataset.runResults = JSON.stringify(results);
      if (runCompleted !== undefined) node.dataset.runCompleted = runCompleted ? '1' : '';
    } catch (_) {}
    if (results != null) {
      let arr = results;
      if (!Array.isArray(arr)) {
        try {
          arr = JSON.parse(node.dataset.runResults || '[]');
        } catch (_) {
          arr = [];
        }
      }
      document.dispatchEvent(new CustomEvent('workflow:run-results-updated', { detail: { nodeId, results: Array.isArray(arr) ? arr : [] } }));
    }
    if (completed != null && total != null) setNodeProgressBar(completed, total);
  }

  function applyRunningLock() {
    runBtn.disabled = false;
    runBtn.textContent = 'Running, click to stop';
    runBtn.classList.remove('btn-primary');
    runBtn.classList.add('btn-secondary', 'btn-danger');
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
      runBtn.disabled = true;
      runBtn.textContent = 'Run completed';
      runBtn.classList.remove('btn-primary', 'btn-danger');
      runBtn.classList.add('btn-secondary');
      llmSelectEl.disabled = true;
      pickerEl.classList.add('run-detail-ws-picker--locked');
      inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
      return;
    }
    if (isRunning()) {
      applyRunningLock();
      return;
    }
    const { results } = getNodeResults();
    const isResumeState = results.length > 0;
    if (isResumeState) {
      llmSelectEl.disabled = true;
      pickerEl.classList.add('run-detail-ws-picker--locked');
      pickerEl.setAttribute('aria-disabled', 'true');
      inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
      overlay.querySelector('.run-detail-main')?.classList.add('run-detail-main--locked');
    } else {
      applyUnlock();
    }
    runBtn.classList.remove('btn-secondary', 'btn-danger');
    runBtn.classList.add('btn-primary');
    runBtn.textContent = isResumeState ? 'Resume' : 'Run';
    const allMapped = inputFields.length === 0 || inputFields.every((name) => (inputToColumn[name] || '').trim());
    runBtn.disabled = !(selectedNodeId && selectedCredentialId && allMapped);
  }

  function getInputHeaders() {
    if (node?.dataset?.runInputContent) {
      try {
        const p = JSON.parse(node.dataset.runInputContent);
        if (Array.isArray(p?.headers)) return p.headers;
      } catch (_) {}
    }
    return getSubsetContent(selectedNodeId)?.headers || [];
  }

  function showResults(results, outputFields, status, placeholderText) {
    resultsState.results = results || [];
    resultsState.outputFields = outputFields || [];
    resultsState.inputHeaders = getInputHeaders();
    resultsState.status = status || 'complete';
    const scrollWrap = rightCol.querySelector('.run-detail-results-table-wrap');
    const savedScrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
    rightCol.innerHTML = '';
    if (!resultsState.results.length) {
      const card = document.createElement('div');
      card.className = 'run-detail-results-card';
      card.innerHTML = `<div class="run-detail-results"><p class="run-detail-placeholder">${escapeHtml(placeholderText || 'Run to see results.')}</p></div>`;
      rightCol.appendChild(card);
    } else {
      rightCol.appendChild(buildResultsCard(resultsState.results, resultsState.outputFields, resultsState.status));
      const newScrollWrap = rightCol.querySelector('.run-detail-results-table-wrap');
      if (newScrollWrap && savedScrollLeft > 0) newScrollWrap.scrollLeft = savedScrollLeft;
    }
  }

  function buildResultsTable(results, outputFields, inputHeaders, inputCollapsed, outputCollapsed, onToggleInputCollapse, onToggleOutputCollapse, zebraMap, firstRowDisplayIndex = 0) {
    const list = (results || []).slice();
    const headers = inputHeaders || [];
    const inCollapsed = !!inputCollapsed;
    const outCollapsed = !!outputCollapsed;
    const tbl = document.createElement('table');
    tbl.className = 'run-detail-results-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const thRowNum = document.createElement('th');
    thRowNum.className = 'run-detail-th run-detail-th--row-display-num';
    thRowNum.textContent = '#';
    thRowNum.title = 'Row number in the current list (after sort/filter)';
    headerRow.appendChild(thRowNum);
    function bindInputColumnCollapseHeader(th, titleExpanded, titleCollapsed) {
      if (typeof onToggleInputCollapse !== 'function') return;
      th.classList.add('run-detail-th--bracket-toggle');
      th.title = inCollapsed ? titleCollapsed : titleExpanded;
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', onToggleInputCollapse);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleInputCollapse();
        }
      });
    }
    function bindOutputColumnCollapseHeader(th, titleExpanded, titleCollapsed) {
      if (typeof onToggleOutputCollapse !== 'function') return;
      th.classList.add('run-detail-th--bracket-toggle');
      th.title = outCollapsed ? titleCollapsed : titleExpanded;
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', onToggleOutputCollapse);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleOutputCollapse();
        }
      });
    }
    const thBracket = document.createElement('th');
    thBracket.className = `run-detail-th run-detail-th--dataset-row-col run-detail-th--input-block-start${inCollapsed ? ' run-detail-bracket-collapsed' : ''}`;
    thBracket.textContent = inCollapsed ? 'Input ...' : 'Input: #';
    if (typeof onToggleInputCollapse === 'function') {
      bindInputColumnCollapseHeader(
        thBracket,
        'Input: # — Dataset input row index. Click any input column header to hide input columns.',
        'Click to expand input columns.',
      );
    } else {
      thBracket.title = inCollapsed ? 'Input columns hidden. Click a header with toggle to expand.' : 'Input: # — Dataset input row index.';
    }
    headerRow.appendChild(thBracket);
    if (!inCollapsed) {
      headers.forEach((h) => {
        const th = document.createElement('th');
        th.className = 'run-detail-th run-detail-th--dataset-row-col';
        const label = `Input: ${String(h ?? '').trim() || ' '}`;
        th.textContent = label;
        if (typeof onToggleInputCollapse === 'function') {
          bindInputColumnCollapseHeader(th, `${label} — Click to hide input columns.`, '');
        } else {
          th.title = label;
        }
        headerRow.appendChild(th);
      });
    }
    if (outCollapsed) {
      const thOutBracket = document.createElement('th');
      thOutBracket.className = 'run-detail-th run-detail-th--dataset-row-col run-detail-th--input-block-sep run-detail-bracket-collapsed';
      thOutBracket.textContent = 'Output ...';
      if (typeof onToggleOutputCollapse === 'function') {
        bindOutputColumnCollapseHeader(
          thOutBracket,
          'Output columns are hidden.',
          'Click to expand model output columns.',
        );
      } else {
        thOutBracket.title = 'Model output columns hidden. Click a header with toggle to expand.';
      }
      headerRow.appendChild(thOutBracket);
    } else {
      const thIndex = document.createElement('th');
      thIndex.className = 'run-detail-th run-detail-th--index run-detail-th--input-block-sep';
      const outputRowLabel = formatResultOutputColumnLabel('#');
      thIndex.textContent = outputRowLabel;
      if (typeof onToggleOutputCollapse === 'function') {
        bindOutputColumnCollapseHeader(
          thIndex,
          'Output: # — Run output row index. Click any output column header to hide output columns.',
          'Click to expand output columns.',
        );
      } else {
        thIndex.title = 'Run output row index (row_index + 1)';
      }
      headerRow.appendChild(thIndex);
      outputFields.forEach((f) => {
        const th = document.createElement('th');
        th.className = 'run-detail-th';
        const label = formatResultOutputColumnLabel((f.display || f.key || '').trim() || '—');
        th.textContent = label;
        th.title = label;
        bindOutputColumnCollapseHeader(th, `${label} — Click to hide output columns.`, '');
        headerRow.appendChild(th);
      });
    }
    thead.appendChild(headerRow);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    list.forEach((r, rowIdx) => {
      const tr = document.createElement('tr');
      const zi = zebraMap?.get(r.input_row_index ?? 0);
      if (zi === 0 || zi === 1) tr.classList.add(`run-detail-results-tr--zebra-${zi}`);
      tr.appendChild(Object.assign(document.createElement('td'), {
        className: 'run-detail-td run-detail-td--row-display-num',
        textContent: String(firstRowDisplayIndex + rowIdx + 1),
      }));
      if (inCollapsed) {
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'run-detail-td run-detail-td--dataset-row-col run-detail-td--input-block-start run-detail-bracket-collapsed', textContent: 'Input ...' }));
      } else {
        const inpIdx = r.input_row_index ?? 0;
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'run-detail-td run-detail-td--dataset-row-col run-detail-td--input-block-start', textContent: String(inpIdx + 1) }));
        const inputRow = Array.isArray(r.input_row) ? r.input_row : [];
        headers.forEach((_, i) => {
          const td = document.createElement('td');
          td.className = 'run-detail-td run-detail-td--dataset-row-col';
          const v = inputRow[i];
          td.textContent = v == null ? '—' : truncate(String(v));
          if (v != null) td.title = String(v);
          tr.appendChild(td);
        });
      }
      if (outCollapsed) {
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'run-detail-td run-detail-td--dataset-row-col run-detail-td--input-block-sep run-detail-bracket-collapsed', textContent: 'Output ...' }));
      } else {
        tr.appendChild(Object.assign(document.createElement('td'), { className: 'run-detail-td run-detail-td--index run-detail-td--input-block-sep', textContent: String((r.row_index ?? 0) + 1) }));
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
    const tableWrap = document.createElement('div');
    tableWrap.className = 'run-detail-results-table-wrap';
    wrap.appendChild(topRow);
    wrap.appendChild(tableWrap);
    const toolbar = document.createElement('div');
    toolbar.className = 'dataset-detail-preview-toolbar run-detail-results-toolbar';
    toolbar.innerHTML = `
      <label class="dataset-detail-rows-label" for="run-detail-rows-per-page">Rows per page</label>
      <select id="run-detail-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === resultsState.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="dataset-detail-pagination-info run-detail-pagination-info" aria-live="polite"></span>
      <label class="dataset-detail-page-label" for="run-detail-page-inp">Page</label>
      <input type="number" id="run-detail-page-inp" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page" />
      <span class="dataset-detail-page-of run-detail-page-of">/ 1</span>
      <div class="dataset-detail-pagination-btns">
        <button type="button" class="btn btn-secondary run-detail-prev-page" aria-label="Previous">Previous</button>
        <button type="button" class="btn btn-secondary run-detail-next-page" aria-label="Next">Next</button>
      </div>
    `;
    const rowsPerPageSelect = toolbar.querySelector('#run-detail-rows-per-page');
    const paginationInfo = toolbar.querySelector('.run-detail-pagination-info');
    const pageInp = toolbar.querySelector('#run-detail-page-inp');
    const pageOfSpan = toolbar.querySelector('.run-detail-page-of');
    const prevBtn = toolbar.querySelector('.run-detail-prev-page');
    const nextBtn = toolbar.querySelector('.run-detail-next-page');

    function refreshTable() {
      const filtered = filterResults(resultsState.results, resultsState.outputFields, resultsState.searchQuery, resultsState.bracketColsCollapsed, resultsState.outputBracketCollapsed);
      const sortedFiltered = filtered.slice().sort(sortRunResultsRows);
      const zebraMap = buildZebraMapForInputGroups(sortedFiltered);
      const totalPages = Math.max(1, Math.ceil(sortedFiltered.length / resultsState.rowsPerPage));
      resultsState.currentPage = Math.min(Math.max(1, resultsState.currentPage), totalPages);
      const start = (resultsState.currentPage - 1) * resultsState.rowsPerPage;
      const pageResults = sortedFiltered.slice(start, start + resultsState.rowsPerPage);
      const onToggleInput = () => {
        resultsState.bracketColsCollapsed = !resultsState.bracketColsCollapsed;
        if (node) node.dataset.runBracketColsCollapsed = resultsState.bracketColsCollapsed ? '1' : '0';
        refreshTable();
      };
      const onToggleOutput = () => {
        resultsState.outputBracketCollapsed = !resultsState.outputBracketCollapsed;
        if (node) node.dataset.runOutputBracketCollapsed = resultsState.outputBracketCollapsed ? '1' : '0';
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        refreshTable();
      };
      const savedScrollLeft = tableWrap.scrollLeft;
      tableWrap.innerHTML = '';
      tableWrap.appendChild(buildResultsTable(
        pageResults,
        resultsState.outputFields,
        resultsState.inputHeaders || [],
        resultsState.bracketColsCollapsed,
        resultsState.outputBracketCollapsed,
        onToggleInput,
        onToggleOutput,
        zebraMap,
        start,
      ));
      if (savedScrollLeft > 0) tableWrap.scrollLeft = savedScrollLeft;
      const totalFiltered = sortedFiltered.length;
      const totalRows = resultsState.results.length;
      paginationInfo.textContent = totalFiltered === 0 ? (totalRows === 0 ? '0 rows' : `0 rows (filtered from ${totalRows})`) : `Showing ${start + 1}–${Math.min(start + resultsState.rowsPerPage, totalFiltered)} of ${totalRows} rows`;
      pageInp.value = String(resultsState.currentPage);
      pageInp.max = String(totalPages);
      pageOfSpan.textContent = `/ ${totalPages}`;
      prevBtn.disabled = resultsState.currentPage <= 1;
      nextBtn.disabled = resultsState.currentPage >= totalPages;
    }

    wrap.querySelector('#run-detail-results-search')?.addEventListener('input', () => { resultsState.searchQuery = wrap.querySelector('#run-detail-results-search').value; resultsState.currentPage = 1; refreshTable(); });
    rowsPerPageSelect?.addEventListener('change', () => { resultsState.rowsPerPage = Number(rowsPerPageSelect.value) || 25; resultsState.currentPage = 1; refreshTable(); });
    pageInp?.addEventListener('change', () => { resultsState.currentPage = Math.max(1, parseInt(pageInp.value, 10) || 1); refreshTable(); });
    prevBtn?.addEventListener('click', () => { resultsState.currentPage = Math.max(1, resultsState.currentPage - 1); refreshTable(); });
    nextBtn?.addEventListener('click', () => {
      const n = filterResults(resultsState.results, resultsState.outputFields, resultsState.searchQuery, resultsState.bracketColsCollapsed, resultsState.outputBracketCollapsed).slice().sort(sortRunResultsRows).length;
      resultsState.currentPage = Math.min(Math.ceil(n / resultsState.rowsPerPage), resultsState.currentPage + 1);
      refreshTable();
    });
    wrap._updateResultsTable = refreshTable;
    refreshTable();

    const footer = document.createElement('div');
    footer.className = 'run-detail-results-footer';
    footer.appendChild(toolbar);
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary run-detail-save-to-workspace-btn';
    saveBtn.textContent = 'Save to workspace';
    saveBtn.addEventListener('click', () => {
      const promptName = (getPromptName() || '').trim() || 'Prompt';
      const baseName = `${promptName} ${runName}`.trim();
      const datasetName = getUniqueDatasetExportName(baseName);
      const ih = resultsState.inputHeaders || [];
      const outputHeaders = (resultsState.outputFields || []).map((f) => formatResultOutputColumnLabel((f.display || f.key || '').trim() || 'output'));
      const inputHeaderLabels = ih.map((h) => 'Input: ' + (String(h ?? '').trim() || ' '));
      const exportHeaders = ['Input: #', ...inputHeaderLabels, formatResultOutputColumnLabel('#'), ...outputHeaders];
      const rows = (resultsState.results || []).map((r) => {
        const outputPart = r.error ? (resultsState.outputFields || []).map(() => String(r.error)) : (resultsState.outputFields || []).map((f) => { const v = r.output?.[f.key]; return v == null ? '—' : Array.isArray(v) ? v.join(', ') : String(v); });
        const inputRow = Array.isArray(r.input_row) ? r.input_row : [];
        const inputPart = ih.map((_, i) => (inputRow[i] == null ? '—' : String(inputRow[i])));
        const inputNum = String((r.input_row_index ?? 0) + 1);
        const outputNum = String((r.row_index ?? 0) + 1);
        return [inputNum, ...inputPart, outputNum, ...outputPart];
      });
      document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', { detail: { name: datasetName, notes: `Exported from ${promptName} ${runName}.\n${resultsState.status === 'complete' ? 'Run completed.' : 'Run incomplete.'}`, headers: exportHeaders, rows } }));
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
    const footerActions = document.createElement('div');
    footerActions.className = 'run-detail-results-footer-actions';
    footerActions.append(saveBtn, scoreBtn);
    footer.appendChild(footerActions);
    wrap.appendChild(footer);
    card.appendChild(wrap);
    card._updateResults = () => wrap._updateResultsTable?.();
    return card;
  }

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
      triggerTextEl.textContent = selectPlaceholderLabel('Select input dataset');
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
      opt.innerHTML = nid ? `<span class="run-detail-ws-option-color" style="background:${escapeHtml(workingSets.find((w) => w.nodeId === nid)?.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(label)}</span>` : `<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">${escapeHtml(selectPlaceholderLabel('Select input dataset'))}</span>`;
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
    if (inputFields.length === 0) { inputsListEl.innerHTML = '<p class="run-detail-placeholder">No prompt inputs.</p>'; refreshButton(); return; }
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
      row.innerHTML = `<span class="run-detail-mapping-cell run-detail-mapping-cell--column" role="cell"><select class="run-detail-column-select" data-input="${escapeAttr(inputName)}" aria-label="Dataset column for ${escapeAttr(inputName)}"><option value="">${escapeHtml(selectPlaceholderLabel('Select column'))}</option>${headers.map((h) => `<option value="${escapeAttr(h)}" ${h === currentCol ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}</select></span><span class="run-detail-mapping-cell run-detail-mapping-cell--arrow" aria-hidden="true">→</span><span class="run-detail-mapping-cell run-detail-mapping-cell--input" role="cell">${escapeHtml(inputName)}</span>`;
      row.querySelector('.run-detail-column-select').addEventListener('change', (e) => {
        inputToColumn[inputName] = (e.target.value || '').trim() || '';
        if (node) try { node.dataset.runInputToColumn = JSON.stringify(inputToColumn); } catch (_) {}
        refreshButton();
      });
      table.appendChild(row);
    });
    inputsListEl.appendChild(table);
    refreshButton();
  }

  function onRunResultsUpdated(e) {
    if (e.detail?.nodeId !== nodeId) return;
    let { results, outputFields, isComplete, cancelled } = e.detail;
    if (isComplete) runId = null;
    if (isComplete && !cancelled && node) node.dataset.runCompleted = '1';
    if (!Array.isArray(results)) return;
    if (!Array.isArray(outputFields) || outputFields.length === 0) outputFields = getNodeResults().outputFields;
    if (outputFields.length === 0 && results.length > 0 && results[0].output && typeof results[0].output === 'object') {
      outputFields = Object.keys(results[0].output).map((k) => ({ key: k, display: k }));
    }
    const status = isComplete ? 'complete' : 'generating';
    resultsState.results = results;
    resultsState.outputFields = outputFields;
    resultsState.inputHeaders = getInputHeaders();
    resultsState.status = status;
    resultsState.currentPage = 1;
    const scrollWrap = rightCol.querySelector('.run-detail-results-table-wrap');
    const savedScrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
    rightCol.innerHTML = '';
    rightCol.appendChild(buildResultsCard(resultsState.results, outputFields, status));
    const newScrollWrap = rightCol.querySelector('.run-detail-results-table-wrap');
    if (newScrollWrap && savedScrollLeft > 0) newScrollWrap.scrollLeft = savedScrollLeft;
    if (isComplete) refreshButton();
    else refreshButton();
  }

  function closeModal() {
    document.removeEventListener('workflow:run-results-updated', onRunResultsUpdated);
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.addEventListener('workflow:run-results-updated', onRunResultsUpdated);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  const runPaneToggle = attachModalPaneToggle({
    overlay,
    isCollapsed: () => overlay.classList.contains('modal-overlay--left-pane-collapsed'),
    onToggle: () => {
      overlay.classList.toggle('modal-overlay--left-pane-collapsed');
      runPaneToggle.update();
    },
    expandedLabel: 'Hide run settings panel',
    collapsedLabel: 'Show run settings panel',
  });

  function isDatasetMappingLocked() {
    return isCompleted() || isRunning() || (getNodeResults().results.length > 0);
  }
  triggerEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (isDatasetMappingLocked()) return;
    if (dropdownEl.hidden) { populateDropdown(); dropdownEl.hidden = false; pickerEl.setAttribute('aria-expanded', 'true'); }
    else { dropdownEl.hidden = true; pickerEl.setAttribute('aria-expanded', 'false'); }
  });
  triggerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isDatasetMappingLocked()) return;
      if (dropdownEl.hidden) { populateDropdown(); dropdownEl.hidden = false; pickerEl.setAttribute('aria-expanded', 'true'); }
      else { dropdownEl.hidden = true; pickerEl.setAttribute('aria-expanded', 'false'); }
    }
  });
  overlay.addEventListener('click', (e) => { if (!pickerEl.contains(e.target)) { dropdownEl.hidden = true; pickerEl.setAttribute('aria-expanded', 'false'); } });

  (async () => {
    llmSelectEl.innerHTML = `<option value="">${escapeHtml(selectPlaceholderLabel('Select model'))}</option>`;
    try {
      const [list, settings] = await Promise.all([
        fetch(`${API_BASE}/api/credentials`).then((r) => r.ok ? r.json() : []),
        fetch(`${API_BASE}/api/settings`).then((r) => r.ok ? r.json() : null),
      ]);
      (list || []).forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.model || c.llm || c.id; llmSelectEl.appendChild(o); });
      if (!selectedCredentialId && settings) {
        const defaultId = (settings.default_run_credential_id || '').trim();
        if (defaultId && (list || []).some((c) => c.id === defaultId)) selectedCredentialId = defaultId;
      }
      if (selectedCredentialId) {
        llmSelectEl.value = selectedCredentialId;
        if (node) node.dataset.runCredentialId = selectedCredentialId;
      }
      refreshButton();
    } catch (e) { console.error('Load credentials:', e); }
  })();
  llmSelectEl.addEventListener('change', () => {
    selectedCredentialId = (llmSelectEl.value || '').trim();
    if (node) node.dataset.runCredentialId = selectedCredentialId || '';
    refreshButton();
  });

  runBtn.addEventListener('click', async () => {
    if (isCompleted()) return;
    if (runId) {
      try {
        await fetch(`${API_BASE}/api/run/cancel/${runId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch (_) {}
      unregisterPendingRun(nodeId);
      runId = null;
      const { results, outputFields } = getNodeResults();
      showResults(results, outputFields, 'incomplete');
      refreshButton();
      return;
    }
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
      if (node && existingResults.length > 0) writeNodeRunState({ results: existingResults, completed: rows.length, total: rows.length, runCompleted: true });
      showResults(existingResults, existingFields, 'complete', 'All rows already completed.');
      refreshButton();
      return;
    }

    const unmapped = inputFields.filter((name) => !(inputToColumn[name] || '').trim());
    if (unmapped.length > 0) {
      showResults([], [], 'complete', `Please map all prompt inputs. Unmapped: ${unmapped.join(', ')}`);
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

    const isResume = nextRowIndex > 0 && existingResults.length > 0;
    if (node) {
      node.dataset.runInputContent = JSON.stringify({ headers, rows });
      if (nextRowIndex === 0) {
        if (existingResults.length === 0) writeNodeRunState({ results: [], completed: 0, total: rows.length, runCompleted: false });
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

    showResults(existingResults, existingFields, 'generating', isResume ? 'Resuming…' : 'Running…');
    applyRunningLock();

    try {
      const res = await fetch(`${API_BASE}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential_id: selectedCredentialId,
          prompts,
          output_schema: outputSchema,
          run_node_id: nodeId || null,
        }),
      });
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
        if (isResume && node) {
          delete node.dataset.runResumeStartIndex;
          delete node.dataset.runResumeExistingResults;
          delete node.dataset.runResumeTotalRows;
        }
        rightCol.innerHTML = `<p class="run-detail-error">${escapeHtml(data.detail || res.statusText || 'Request failed')}</p>`;
        refreshButton();
        return;
      }
      let results = data.results || [];
      const outputFields = data.output_fields || [];
      const runContent = { headers, rows };
      if (isResume) {
        results = mergeResumeResults(existingResults, results, nextRowIndex, runContent);
      } else {
        results = processApiResults(results, runContent);
      }
      results = markEmptyOutputAsError(results);
      runId = null;
      if (node && isResume) {
        delete node.dataset.runResumeStartIndex;
        delete node.dataset.runResumeExistingResults;
        delete node.dataset.runResumeTotalRows;
      }
      writeNodeRunState({ results, completed: rows.length, total: rows.length, runCompleted: true });
      showResults(results, outputFields, 'complete');
    } catch (e) {
      runId = null;
      resultsState.status = 'complete';
      if (isResume && node) {
        delete node.dataset.runResumeStartIndex;
        delete node.dataset.runResumeExistingResults;
        delete node.dataset.runResumeTotalRows;
      }
      rightCol.innerHTML = `<p class="run-detail-error">${escapeHtml(String(e.message || e))}</p>`;
    }
    refreshButton();
  });

  updateTriggerDisplay();
  updateRunNodeBorder();
  renderInputMappings();
  refreshButton();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  rightCol.innerHTML = '';
  try {
    const { results, outputFields } = getNodeResults();
    if (Array.isArray(results) && results.length > 0) {
      const pct = node?.querySelector('.workflow-node__run-progress')?.getAttribute('aria-valuenow');
      const status = runId ? 'generating' : (pct === '100' ? 'complete' : 'incomplete');
      resultsState.results = results;
      resultsState.outputFields = outputFields;
      resultsState.inputHeaders = getInputHeaders();
      resultsState.status = status;
      rightCol.appendChild(buildResultsCard(resultsState.results, outputFields, status));
    }
  } catch (_) {}
  if (!rightCol.firstChild) {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card';
    card.innerHTML = `<div class="run-detail-results"><p class="run-detail-placeholder">${runId ? 'Running…' : 'Run to see results.'}</p></div>`;
    rightCol.appendChild(card);
  }
}
