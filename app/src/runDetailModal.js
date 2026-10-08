/**
 * Run 节点详情弹窗
 *
 * 选数据集、列映射、模型 → Run / Resume → 右侧表格显示结果
 * input_row_index 统一 0-based，展示时 +1
 */

import { embedInputRow, markEmptyOutputAsError } from './runResumeUtils.js';
import { selectPlaceholderLabel, formatResultOutputColumnLabel } from './displayTextNormalize.js';
import { bindNodePicker, nodePickerHtml } from './nodePicker.js';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { cloneCell, displayCell } from './datasetContent.js';
import { deriveOutputFields } from './runResultsExport.js';
import { ensureRunNodeModel } from './nodeSettings.js';
import { attachRunHistoryPicker } from './runHistoryPicker.js';
import { executionIdleLabel } from './executionResumeState.js';

const API_BASE = BACKEND_API_BASE;
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
    if (inputRow.some((v) => v != null && displayCell(v).toLowerCase().includes(q))) return true;
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

// Shared with the canvas's "Save to workspace" and the Agent; re-exported for existing importers.
export { deriveOutputFields };

export function openRunDetailModal({
  node,
  startRunNode,
  getWorkingSets = () => [],
  getPrompts = () => [],
  getPromptId = () => '',
  selectPrompt = () => {},
  getPromptInputFields = () => [],
  getSubsetContent = () => ({ headers: [], rows: [] }),
  getPromptTemplate = () => ({ sections: [], outputSchema: { return_shape: 'single', fields: [] } }),
  unregisterPendingRun = () => {},
  getPendingRunId = () => null,
  getPromptName = () => '',
  getUniqueDatasetExportName = (n) => n,
  isRunNameAlreadyUsedForPrompt = () => false,
  getRunMappingsFromCanvas,
  onWorkingSetChange = () => {},
  getInputSource = () => null,
  setInputSource = () => {},
  history = null,
}) {
  (getRunMappingsFromCanvas?.() || []).forEach((parsed) => {
    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([inputName, columnName]) => {
        if (inputName != null && String(columnName || '').trim()) inputNameToColumnMemory[inputName] = String(columnName).trim();
      });
    }
  });

  let inputFields = getPromptInputFields();
  let selectedNodeId = getInputSource()?.nodeId || '';
  let selectedCredentialId = (node?.dataset?.runCredentialId || '').trim();
  const runName = (node?.dataset?.runName || node?.querySelector?.('.workflow-node__title')?.textContent?.trim() || 'Run').trim() || 'Run';
  const nodeId = node?.dataset?.nodeId || '';
  const historyMode = !!history;

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
              <label class="dataset-meta-label" for="run-detail-prompt-picker">Input prompt</label>
              ${nodePickerHtml({ id: 'run-detail-prompt-picker', placeholder: 'Select input prompt', ariaLabel: 'Select input prompt' })}
            </div>
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
                <button type="button" class="btn btn-primary run-detail-run-btn" disabled>Run</button>
              </div>
            </div>
          </div>
        </div>
        <div class="run-detail-preview-wrap">
          <div class="run-detail-preview-header">
            <h3 class="run-detail-preview-title">Results</h3>
          </div>
          <div class="run-detail-preview-content"></div>
        </div>
      </div>
    </div>
  `;

  const pickerEl = overlay.querySelector('#run-detail-ws-picker');
  const triggerEl = pickerEl.querySelector('.run-detail-ws-trigger');
  const triggerColorEl = overlay.querySelector('#run-detail-ws-trigger-color');
  const triggerTextEl = overlay.querySelector('#run-detail-ws-trigger-text');
  const dropdownEl = overlay.querySelector('#run-detail-ws-dropdown');
  const formErrorEl = overlay.querySelector('#run-detail-form-error');
  const inputsListEl = overlay.querySelector('#run-detail-inputs-list');
  // Same picker as the Input dataset below it; it locks with the Dataset once the Run has results.
  const promptPicker = bindNodePicker(overlay.querySelector('#run-detail-prompt-picker'), {
    placeholder: 'Select input prompt',
    getOptions: getPrompts,
    getValue: getPromptId,
    onSelect: (promptNodeId) => {
      selectPrompt(promptNodeId);
      inputFields = getPromptInputFields();
      // Keep only the mapping for the new Prompt's inputs; the column memory refills matching names.
      inputToColumn = Object.fromEntries(Object.entries(inputToColumn).filter(([name]) => inputFields.includes(name)));
      if (node) try { node.dataset.runInputToColumn = JSON.stringify(inputToColumn); } catch (_) {}
      renderInputMappings();
      refreshButton();
    },
    isLocked: () => isRunning() || (!historyMode && (isCompleted() || getNodeResults().results.length > 0)),
    closeWithin: overlay,
  });
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

  function applyRunningLock() {
    runBtn.disabled = false;
    runBtn.textContent = 'Running, click to stop';
    runBtn.classList.remove('btn-primary');
    runBtn.classList.add('btn-secondary', 'btn-danger');
    pickerEl.classList.add('run-detail-ws-picker--locked');
    pickerEl.setAttribute('aria-disabled', 'true');
    promptPicker.setLocked(true);
    inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
    overlay.querySelector('.run-detail-main')?.classList.add('run-detail-main--locked');
  }

  function applyUnlock() {
    promptPicker.setLocked(false);
    pickerEl.classList.remove('run-detail-ws-picker--locked');
    pickerEl.removeAttribute('aria-disabled');
    inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = false; });
    overlay.querySelector('.run-detail-main')?.classList.remove('run-detail-main--locked');
  }

  function refreshButton() {
    if (isCompleted()) {
      runBtn.disabled = !historyMode;
      runBtn.textContent = 'Run again';
      runBtn.classList.remove('btn-primary', 'btn-danger');
      runBtn.classList.add('btn-secondary');
      if (historyMode) applyUnlock();
      else {
        pickerEl.classList.add('run-detail-ws-picker--locked');
        pickerEl.setAttribute('aria-disabled', 'true');
        promptPicker.setLocked(true);
        inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
        overlay.querySelector('.run-detail-main')?.classList.add('run-detail-main--locked');
      }
      return;
    }
    if (isRunning()) {
      applyRunningLock();
      return;
    }
    const { results } = getNodeResults();
    const isResumeState = results.length > 0 || node?.dataset?.runResumable === '1';
    if (isResumeState && !historyMode) {
      pickerEl.classList.add('run-detail-ws-picker--locked');
      pickerEl.setAttribute('aria-disabled', 'true');
      promptPicker.setLocked(true);
      inputsListEl.querySelectorAll('select, input').forEach((el) => { el.disabled = true; });
      overlay.querySelector('.run-detail-main')?.classList.add('run-detail-main--locked');
    } else {
      applyUnlock();
    }
    runBtn.classList.remove('btn-secondary', 'btn-danger');
    runBtn.classList.add('btn-primary');
    runBtn.textContent = executionIdleLabel({ interrupted: node?.dataset?.runResumable === '1', hasPartial: results.length > 0 });
    const allMapped = inputFields.length === 0 || inputFields.every((name) => (inputToColumn[name] || '').trim());
    runBtn.disabled = !(getPromptId() && selectedNodeId && allMapped);
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
          td.textContent = v == null ? '—' : truncate(displayCell(v));
          if (v != null) td.title = displayCell(v);
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
        const inputPart = ih.map((_, i) => (inputRow[i] == null ? '—' : cloneCell(inputRow[i])));
        const inputNum = String((r.input_row_index ?? 0) + 1);
        const outputNum = String((r.row_index ?? 0) + 1);
        return [inputNum, ...inputPart, outputNum, ...outputPart];
      });
      let sourceTypes = [];
      try { sourceTypes = JSON.parse(node?.dataset?.runInputContent || '{}').columnTypes || []; } catch (_) {}
      const columnTypes = ['text', ...ih.map((_, i) => (sourceTypes[i] === 'image' || sourceTypes[i] === 'pdf') ? sourceTypes[i] : 'text'), 'text', ...outputHeaders.map(() => 'text')];
      document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', { detail: { name: datasetName, notes: `Exported from ${promptName} ${runName}.\n${resultsState.status === 'complete' ? 'Run completed.' : 'Run incomplete.'}`, headers: exportHeaders, columnTypes, rows, runNodeId: node?.dataset?.nodeId || '' } }));
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
      setInputSource(selectedNodeId ? { nodeId: selectedNodeId, port: 'result' } : null);
      const bar = node.querySelector('.workflow-node__run-progress');
      if (bar) bar.style.background = ws?.color || bar.style.background;
      document.dispatchEvent(new CustomEvent('workflow:refresh-node-colors'));
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
    const previousNodeId = selectedNodeId;
    selectedNodeId = id || '';
    updateTriggerDisplay();
    updateRunNodeBorder();
    dropdownEl.hidden = true;
    pickerEl.setAttribute('aria-expanded', 'false');
    dropdownEl.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', o.dataset.nodeId === selectedNodeId ? 'true' : 'false'));
    renderInputMappings();
    refreshButton();
    if (selectedNodeId !== previousNodeId) {
      onWorkingSetChange({ runNodeId: nodeId, datasetNodeId: selectedNodeId });
    }
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
    const columnTypes = headers.map((_, i) => (content?.columnTypes?.[i] === 'image' || content?.columnTypes?.[i] === 'pdf') ? content.columnTypes[i] : 'text');
    const inputTypes = getPromptTemplate()?.inputTypes || {};
    const headerSet = new Set(headers);
    inputsListEl.innerHTML = '';
    if (inputFields.length === 0) {
      inputsListEl.innerHTML = `<p class="run-detail-placeholder">${getPromptId() ? 'No prompt inputs.' : 'Choose an Input prompt first.'}</p>`;
      refreshButton();
      return;
    }
    inputFields.forEach((inputName) => {
      let col = inputToColumn[inputName] || '';
      const expected = inputTypes[inputName];
      const selectedIndex = headers.indexOf(col);
      if (col && expected && columnTypes[selectedIndex] !== expected) { col = ''; inputToColumn[inputName] = ''; }
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
      const requiredType = inputTypes[inputName];
      const options = headers.map((h, i) => ({ h, type: columnTypes[i] })).filter((entry) => !requiredType || entry.type === requiredType);
      row.innerHTML = `<span class="run-detail-mapping-cell run-detail-mapping-cell--column" role="cell"><select class="run-detail-column-select" data-input="${escapeAttr(inputName)}" aria-label="Dataset column for ${escapeAttr(inputName)}"><option value="">${escapeHtml(selectPlaceholderLabel('Select column'))}</option>${options.map(({ h, type }) => `<option value="${escapeAttr(h)}" ${h === currentCol ? 'selected' : ''}>${escapeHtml(h)}${type === 'image' ? ' 🖼' : type === 'pdf' ? ' 📄' : ''}</option>`).join('')}</select></span><span class="run-detail-mapping-cell run-detail-mapping-cell--arrow" aria-hidden="true">→</span><span class="run-detail-mapping-cell run-detail-mapping-cell--input" role="cell">${escapeHtml(inputName)}${requiredType ? ` <small>(${requiredType})</small>` : ''}</span>`;
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
    let { results, outputFields, isComplete, cancelled, error } = e.detail;
    if (isComplete) runId = null;
    if (isComplete && !cancelled && node) node.dataset.runCompleted = '1';
    if (cancelled && error) {
      formErrorEl.textContent = String(error);
      formErrorEl.hidden = false;
    }
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
    document.removeEventListener('workflow:history-resolved', onHistoryResolved);
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.addEventListener('workflow:run-results-updated', onRunResultsUpdated);
  function onHistoryResolved() {
    if (!historyMode || isRunning() || !overlay.isConnected) return;
    const { results, outputFields } = getNodeResults();
    showResults(results, outputFields, isCompleted() ? 'complete' : (results.length ? 'incomplete' : 'complete'));
    refreshButton();
  }
  if (historyMode) document.addEventListener('workflow:history-resolved', onHistoryResolved);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  attachModalPaneCycle({
    overlay,
    bothLabel: 'Show both panels',
    leftOnlyLabel: 'Show run settings panel only',
    rightOnlyLabel: 'Show results panel only',
  });
  if (history) attachRunHistoryPicker({
    overlay, loadEntries: history.loadEntries,
    onSelect: (recordId) => history.select(recordId, closeModal),
    onDelete: history.delete,
    isDisabled: isRunning,
  });

  function isDatasetMappingLocked() {
    return isRunning() || (!historyMode && (isCompleted() || getNodeResults().results.length > 0));
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
    if (!node) return;
    await ensureRunNodeModel(node);
    selectedCredentialId = (node.dataset.runCredentialId || '').trim();
    refreshButton();
  })();


  runBtn.addEventListener('click', async () => {
    try {
      if (historyMode) await history.reconcile?.();
    } catch (error) {
      formErrorEl.textContent = String(error?.message || error);
      formErrorEl.hidden = false;
      return;
    }
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
    if (!selectedNodeId) return;
    const emptyInput = getSubsetContent(selectedNodeId)?.rows?.length === 0;
    if (!selectedCredentialId && !emptyInput) {
      await ensureRunNodeModel(node);
      selectedCredentialId = (node?.dataset?.runCredentialId || '').trim();
    }
    if (!selectedCredentialId && !emptyInput) {
      formErrorEl.textContent = 'No Run model: set a default Run model in Settings.';
      formErrorEl.hidden = false;
      return;
    }
    formErrorEl.hidden = true;

    const runAgain = isCompleted();
    const { results: existingResults, outputFields: existingFields } = getNodeResults();
    showResults(runAgain ? [] : existingResults, runAgain ? [] : existingFields, 'generating', runAgain ? 'Running…' : (existingResults.length ? 'Resuming…' : 'Running…'));
    applyRunningLock();

    try {
      const started = await startRunNode({ runNodeId: nodeId });
      runId = started.runId || null;
      if (started.alreadyComplete) {
        const { results, outputFields } = getNodeResults();
        showResults(results, outputFields, 'complete', 'All rows already completed.');
      } else if (started.completed) {
        const { results, outputFields } = getNodeResults();
        showResults(results, outputFields, 'complete');
      }
    } catch (e) {
      runId = null;
      resultsState.status = 'complete';
      const message = String(e?.message || e);
      formErrorEl.textContent = message;
      formErrorEl.hidden = false;
      rightCol.innerHTML = `<p class="run-detail-error">${escapeHtml(message)}</p>`;
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
