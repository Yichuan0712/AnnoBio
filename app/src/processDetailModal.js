/**
 * Process node detail modal: write a Python function, run it once per row of the connected
 * Dataset. The code runs on the backend via whatever Python interpreter is configured in
 * Settings (system install or a venv) -- see backend/process_exec.py -- one row at a time,
 * same sequential/isolate-failures behavior the LLM-based Run node has. Layout mirrors the
 * Run detail modal: left column is the settings/editor pane with the Run button pinned to
 * its bottom, right column is Results (same search + pagination toolbar convention as
 * Run/Dataset detail tables).
 */

import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { attachModalPaneToggle } from './paneToggleButton.js';
import { BACKEND_API_BASE } from './backendConfig.js';

const API_BASE = BACKEND_API_BASE;

const FALLBACK_DEFAULT_CODE = `def process(row):
    # row holds this row's data. Read any column by name, e.g. row["column_name"].
    # Return a dict: each key becomes an output column, its value is that column's output.
    # By default, just return the row as-is (all original columns, unchanged).
    return row
`;

const MAX_COMMENT_LINE_CHARS = 70;

/** Wraps a comma-separated list into comment-prefixed lines no longer than MAX_COMMENT_LINE_CHARS. */
function wrapCommentList(prefix, continuationPrefix, items) {
  const lines = [];
  let current = prefix;
  items.forEach((item, i) => {
    const piece = (i === 0 ? '' : ', ') + item;
    if (current !== prefix && current.length + piece.length > MAX_COMMENT_LINE_CHARS) {
      lines.push(current);
      current = continuationPrefix + item;
    } else {
      current += piece;
    }
  });
  lines.push(current);
  return lines.join('\n');
}

/** Builds sample code listing the connected dataset's actual columns, so the user can edit in place. */
function buildDefaultCode(headers) {
  const cols = (Array.isArray(headers) ? headers : []).map((h) => String(h ?? ''));
  if (cols.length === 0) return FALLBACK_DEFAULT_CODE;
  const returnLines = cols.map((c) => `        ${JSON.stringify(c)}: row[${JSON.stringify(c)}],`).join('\n');
  return `def process(row):
${wrapCommentList('    # Columns: ', '    #   ', cols)}
    # Return a dict: each key becomes an output column, its value is that column's output.
    # By default, just return the row as-is -- edit any line below to transform a column.
    return {
${returnLines}
    }
`;
}

const PROCESS_POLL_INTERVAL_MS = 1200;
const MAX_PREVIEW_CELL_CHARS = 200;
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function truncate(str) {
  const s = String(str ?? '');
  return s.length > MAX_PREVIEW_CELL_CHARS ? s.slice(0, MAX_PREVIEW_CELL_CHARS) + '…' : s;
}

function filterProcessRows(headers, rows, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.some((v) => v != null && String(v).toLowerCase().includes(q)));
}

/**
 * @param {{ node: HTMLElement, getSourceDatasetContent: () => { headers: string[], rows: string[][] }, getUniqueDatasetExportName?: (base: string) => string }} options
 */
export function openProcessDetailModal({ node, getSourceDatasetContent, getUniqueDatasetExportName }) {
  const nodeId = (node?.dataset?.nodeId ?? '').trim();
  const existing = nodeId
    ? document.querySelector(`.modal-overlay[data-process-node-id="${CSS.escape(nodeId)}"]`)
    : null;
  if (existing) {
    document.body.appendChild(existing);
    return;
  }

  const title = (node?.dataset?.processName || 'Process').trim() || 'Process';
  const savedCode = node?.dataset?.processCode;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'process-detail-title');
  if (nodeId) overlay.dataset.processNodeId = nodeId;
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--process">
      <div class="modal-header">
        <h2 id="process-detail-title" class="modal-title">Process: ${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body run-detail-body modal-body--run">
        <div class="run-detail-main">
          <p class="run-detail-main-label">Code</p>
          <div class="process-editor-mid">
            <div class="process-editor-host" id="process-editor-host"></div>
            <p class="process-editor-hint">Runs once per row of the connected dataset, using the Python interpreter set in Settings → Python. <code>row</code> is a dict keyed by the dataset's column names. Return value's keys become the output columns. Return nothing (or <code>None</code>) to skip a row.</p>
          </div>
          <div class="dataset-meta-field run-detail-model-actions-field">
            <div class="run-detail-llm-actions-row">
              <span class="run-detail-llm-actions-lead" aria-hidden="true"></span>
              <div class="run-detail-llm-actions-right">
                <button type="button" class="btn btn-secondary run-detail-run-btn process-run-btn">Run</button>
              </div>
            </div>
          </div>
        </div>
        <div class="run-detail-preview-wrap">
          <h3 class="run-detail-preview-title">Results</h3>
          <div class="run-detail-preview-content process-results-content"></div>
        </div>
      </div>
    </div>
  `;

  const editorHost = overlay.querySelector('#process-editor-host');
  const resultsContent = overlay.querySelector('.process-results-content');
  const runBtn = overlay.querySelector('.process-run-btn');

  const editorView = new EditorView({
    doc: (savedCode != null && savedCode !== '') ? savedCode : buildDefaultCode(getSourceDatasetContent().headers),
    extensions: [basicSetup, python()],
    parent: editorHost,
  });

  let running = false;
  let cancelled = false;
  let currentJobId = null;
  /** @type {{ headers: string[], rows: string[][] } | null} */
  let lastResults = null;
  const resultsState = { headers: [], rows: [], searchQuery: '', rowsPerPage: 25, currentPage: 1 };
  let saveBtnEl = null;
  const progressBar = node?.querySelector?.('.workflow-node__process-progress') || null;

  function getCode() {
    return editorView.state.doc.toString();
  }

  function setNodeProgress(completed, total) {
    if (!progressBar) return;
    const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    progressBar.style.width = pct + '%';
    progressBar.setAttribute('aria-valuenow', String(pct));
  }

  function persistResults(results) {
    if (!node?.dataset) return;
    if (results) node.dataset.processResults = JSON.stringify(results);
    else delete node.dataset.processResults;
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  function showPlaceholder(text) {
    resultsContent.innerHTML = `<div class="run-detail-results-card process-results-card"><div class="run-detail-results"><p class="run-detail-placeholder">${escapeHtml(text)}</p></div></div>`;
    saveBtnEl = null;
  }

  function buildResultsTable(headers, rows) {
    const table = document.createElement('table');
    table.className = 'run-detail-results-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      th.title = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      headers.forEach((_, i) => {
        const td = document.createElement('td');
        td.textContent = truncate(row[i]);
        td.title = row[i] ?? '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function showResultsCard(headers, rows, statusText) {
    resultsState.headers = headers;
    resultsState.rows = rows;
    resultsState.currentPage = 1;
    resultsContent.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'run-detail-results-card process-results-card';
    const wrap = document.createElement('div');
    wrap.className = 'run-detail-results';

    const statusNote = document.createElement('span');
    statusNote.className = 'run-detail-results-note run-detail-results-note--inline';
    statusNote.textContent = statusText || '';
    const topRow = document.createElement('div');
    topRow.className = 'run-detail-results-top-row';
    topRow.appendChild(statusNote);
    const searchWrap = document.createElement('div');
    searchWrap.className = 'dataset-detail-preview-search-wrap run-detail-results-search-wrap';
    searchWrap.innerHTML = `<label class="dataset-detail-search-label" for="process-results-search">Search</label><input type="text" id="process-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" />`;
    topRow.appendChild(searchWrap);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'run-detail-results-table-wrap';
    wrap.appendChild(topRow);
    wrap.appendChild(tableWrap);

    const footer = document.createElement('div');
    footer.className = 'run-detail-results-footer process-results-footer';
    const toolbar = document.createElement('div');
    toolbar.className = 'dataset-detail-preview-toolbar run-detail-results-toolbar';
    toolbar.innerHTML = `
      <label class="dataset-detail-rows-label" for="process-rows-per-page">Rows per page</label>
      <select id="process-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === resultsState.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <span class="dataset-detail-pagination-info process-pagination-info" aria-live="polite"></span>
      <label class="dataset-detail-page-label" for="process-page-inp">Page</label>
      <input type="number" id="process-page-inp" class="dataset-detail-page-inp" min="1" value="1" aria-label="Page" />
      <span class="dataset-detail-page-of process-page-of">/ 1</span>
      <div class="dataset-detail-pagination-btns">
        <button type="button" class="btn btn-secondary process-prev-page" aria-label="Previous">Previous</button>
        <button type="button" class="btn btn-secondary process-next-page" aria-label="Next">Next</button>
      </div>
    `;
    const rowsPerPageSelect = toolbar.querySelector('#process-rows-per-page');
    const paginationInfo = toolbar.querySelector('.process-pagination-info');
    const pageInp = toolbar.querySelector('#process-page-inp');
    const pageOfSpan = toolbar.querySelector('.process-page-of');
    const prevBtn = toolbar.querySelector('.process-prev-page');
    const nextBtn = toolbar.querySelector('.process-next-page');

    function refreshTable() {
      const filtered = filterProcessRows(resultsState.headers, resultsState.rows, resultsState.searchQuery);
      const totalPages = Math.max(1, Math.ceil(filtered.length / resultsState.rowsPerPage));
      resultsState.currentPage = Math.min(Math.max(1, resultsState.currentPage), totalPages);
      const start = (resultsState.currentPage - 1) * resultsState.rowsPerPage;
      const pageRows = filtered.slice(start, start + resultsState.rowsPerPage);
      const savedScrollLeft = tableWrap.scrollLeft;
      tableWrap.innerHTML = '';
      tableWrap.appendChild(buildResultsTable(resultsState.headers, pageRows));
      if (savedScrollLeft > 0) tableWrap.scrollLeft = savedScrollLeft;
      const totalRows = resultsState.rows.length;
      paginationInfo.textContent = filtered.length === 0 ? (totalRows === 0 ? '0 rows' : `0 rows (filtered from ${totalRows})`) : `Showing ${start + 1}–${Math.min(start + resultsState.rowsPerPage, filtered.length)} of ${totalRows} rows`;
      pageInp.value = String(resultsState.currentPage);
      pageInp.max = String(totalPages);
      pageOfSpan.textContent = `/ ${totalPages}`;
      prevBtn.disabled = resultsState.currentPage <= 1;
      nextBtn.disabled = resultsState.currentPage >= totalPages;
    }

    searchWrap.querySelector('#process-results-search').addEventListener('input', (e) => {
      resultsState.searchQuery = e.target.value;
      resultsState.currentPage = 1;
      refreshTable();
    });
    rowsPerPageSelect.addEventListener('change', () => { resultsState.rowsPerPage = Number(rowsPerPageSelect.value) || 25; resultsState.currentPage = 1; refreshTable(); });
    pageInp.addEventListener('change', () => { resultsState.currentPage = Math.max(1, parseInt(pageInp.value, 10) || 1); refreshTable(); });
    prevBtn.addEventListener('click', () => { resultsState.currentPage = Math.max(1, resultsState.currentPage - 1); refreshTable(); });
    nextBtn.addEventListener('click', () => {
      const n = filterProcessRows(resultsState.headers, resultsState.rows, resultsState.searchQuery).length;
      resultsState.currentPage = Math.min(Math.max(1, Math.ceil(n / resultsState.rowsPerPage)), resultsState.currentPage + 1);
      refreshTable();
    });

    const actions = document.createElement('div');
    actions.className = 'run-detail-results-footer-actions';
    saveBtnEl = document.createElement('button');
    saveBtnEl.type = 'button';
    saveBtnEl.className = 'btn btn-primary run-detail-save-to-workspace-btn process-save-btn';
    saveBtnEl.textContent = 'Export result';
    saveBtnEl.disabled = running;
    saveBtnEl.addEventListener('click', () => {
      if (!lastResults) return;
      const baseName = `${title} results`;
      const name = typeof getUniqueDatasetExportName === 'function' ? getUniqueDatasetExportName(baseName) : baseName;
      document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', {
        detail: {
          name,
          notes: `Exported from Process "${title}".`,
          headers: lastResults.headers,
          rows: lastResults.rows,
          processNodeId: node?.dataset?.nodeId || '',
        },
      }));
    });
    actions.appendChild(saveBtnEl);
    footer.append(toolbar, actions);
    wrap.appendChild(footer);
    card.appendChild(wrap);
    resultsContent.appendChild(card);
    refreshTable();
  }

  function setRunningUi(isRunning) {
    running = isRunning;
    runBtn.textContent = isRunning ? 'Running, click to stop' : 'Run';
    runBtn.classList.toggle('btn-danger', isRunning);
    if (saveBtnEl) saveBtnEl.disabled = isRunning || !lastResults;
  }

  /** Turns raw {ok, result, error} outcomes into the results table, applying the skip-on-empty-return rule. */
  function finishRun(outcomes, total, wasCancelled) {
    const perRow = [];
    let skippedCount = 0;
    outcomes.forEach((outcome) => {
      if (outcome.ok && (outcome.result === null || outcome.result === undefined)) {
        // Returning nothing means "skip this row" -- it's left out of the output entirely.
        skippedCount++;
      } else {
        const output = outcome.ok
          ? (outcome.result && typeof outcome.result === 'object' ? outcome.result : { result: outcome.result })
          : null;
        perRow.push({ output, error: outcome.ok ? null : outcome.error });
      }
    });

    const outputKeys = [];
    perRow.forEach((r) => {
      if (!r.output) return;
      Object.keys(r.output).forEach((k) => { if (!outputKeys.includes(k)) outputKeys.push(k); });
    });
    // Only add an "error" column when something actually failed -- otherwise a fully
    // successful run (e.g. the default code, which just echoes each row back) ends up with
    // an extra trailing empty cell on every row, making it look different from the input
    // even when every value is identical.
    const errorCount = perRow.filter((r) => r.error).length;
    const headers = errorCount > 0 ? [...outputKeys, 'error'] : outputKeys;
    const rows = perRow.map((r) => {
      const row = outputKeys.map((k) => (r.output ? String(r.output[k] ?? '') : ''));
      if (errorCount > 0) row.push(r.error || '');
      return row;
    });
    lastResults = perRow.length ? { headers, rows } : null;
    persistResults(lastResults);

    const succeededCount = perRow.length - errorCount;
    const skippedSuffix = skippedCount > 0 ? `, ${skippedCount} skipped` : '';
    let statusText;
    if (wasCancelled) {
      statusText = `Cancelled after ${outcomes.length}/${total} rows${skippedSuffix}.`;
    } else if (errorCount > 0) {
      statusText = `Done. ${succeededCount} succeeded, ${errorCount} failed${skippedSuffix} (of ${total}).`;
    } else if (skippedCount > 0) {
      statusText = `Done. ${succeededCount} rows processed${skippedSuffix} (of ${total}).`;
    } else {
      statusText = `Done. ${perRow.length}/${perRow.length} rows processed.`;
    }
    setRunningUi(false);
    if (perRow.length) showResultsCard(headers, rows, statusText);
    else showPlaceholder(skippedCount > 0 ? `All ${skippedCount} rows skipped.` : 'No rows processed.');
  }

  async function pollJob(jobId, total) {
    if (currentJobId !== jobId) return; // superseded -- a newer run started, or the modal moved on
    let data;
    try {
      const res = await fetch(`${API_BASE}/api/process/run/result/${jobId}`);
      data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) throw new Error(data.detail || 'Failed to fetch results');
    } catch (e) {
      if (currentJobId !== jobId) return;
      setRunningUi(false);
      showPlaceholder((e && e.message) || 'Network error while checking progress.');
      return;
    }
    if (currentJobId !== jobId) return;
    const total2 = data.total || total;
    if (data.status === 'running') {
      setNodeProgress(data.completed || 0, total2);
      showPlaceholder(`Processing… ${data.completed || 0}/${total2}`);
      setTimeout(() => pollJob(jobId, total), PROCESS_POLL_INTERVAL_MS);
      return;
    }
    setNodeProgress((data.results || []).length, total2);
    if (data.error) {
      setRunningUi(false);
      showPlaceholder(data.error);
      return;
    }
    finishRun(data.results || [], total2, data.status === 'cancelled' || cancelled);
  }

  async function startRun() {
    const { headers: inputHeaders, rows: inputRows } = getSourceDatasetContent();
    if (!inputRows || inputRows.length === 0) {
      showPlaceholder('Connected dataset has no rows.');
      return;
    }

    let pythonPath = '';
    try {
      const res = await fetch(`${API_BASE}/api/settings`);
      const settings = res.ok ? await res.json() : null;
      pythonPath = (settings?.python_path || '').trim();
    } catch (_) {}
    if (!pythonPath) {
      showPlaceholder('Set a Python interpreter path in Settings → Python first.');
      return;
    }

    cancelled = false;
    setRunningUi(true);
    setNodeProgress(0, inputRows.length);
    showPlaceholder('Starting…');

    try {
      const res = await fetch(`${API_BASE}/api/process/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path: pythonPath, code: getCode(), headers: inputHeaders, rows: inputRows }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRunningUi(false);
        showPlaceholder(typeof data.detail === 'string' ? data.detail : 'Failed to start.');
        return;
      }
      currentJobId = data.job_id;
    } catch (e) {
      setRunningUi(false);
      showPlaceholder((e && e.message) || 'Network error.');
      return;
    }

    pollJob(currentJobId, inputRows.length);
  }

  runBtn.addEventListener('click', () => {
    if (running) {
      cancelled = true;
      if (currentJobId) {
        fetch(`${API_BASE}/api/process/run/cancel/${currentJobId}`, { method: 'POST' }).catch(() => {});
      }
      return;
    }
    startRun();
  });

  function close() {
    if (node && node.dataset) node.dataset.processCode = getCode();
    if (running && currentJobId) {
      fetch(`${API_BASE}/api/process/run/cancel/${currentJobId}`, { method: 'POST' }).catch(() => {});
    }
    currentJobId = null;
    editorView.destroy();
    overlay.remove();
    document.body.style.overflow = '';
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);

  const processPaneToggle = attachModalPaneToggle({
    overlay,
    isCollapsed: () => overlay.classList.contains('modal-overlay--process-results-collapsed'),
    onToggle: () => {
      overlay.classList.toggle('modal-overlay--process-results-collapsed');
      processPaneToggle.update();
    },
    expandedLabel: 'Hide results panel',
    collapsedLabel: 'Show results panel',
  });

  let restored = null;
  try {
    const raw = node?.dataset?.processResults;
    if (raw) restored = JSON.parse(raw);
  } catch (_) {}
  if (restored && Array.isArray(restored.headers) && Array.isArray(restored.rows) && restored.rows.length) {
    lastResults = restored;
    const errIdx = restored.headers.indexOf('error');
    const total = restored.rows.length;
    const errorCount = errIdx >= 0 ? restored.rows.filter((r) => r[errIdx]).length : 0;
    const statusText = errorCount > 0
      ? `Done. ${total - errorCount}/${total} succeeded, ${errorCount} failed.`
      : `Done. ${total}/${total} rows processed.`;
    showResultsCard(restored.headers, restored.rows, statusText);
  } else {
    showPlaceholder('No results yet. Click Run.');
  }
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
