/**
 * Process node detail modal: write a Python function, run it against the connected Dataset. Two
 * tabs: "Process by row" (process(row), called once per row, backend/process_exec.py -- same
 * sequential/isolate-failures behavior the LLM-based Run node has) and "Process as df"
 * (process(df), called once on the whole dataset as a pandas DataFrame, backend/process_df_exec.py
 * -- for whole-table transforms, filters, or ad-hoc sampling that a per-row function can't express).
 * Layout mirrors the Run detail modal: left column is the settings/editor pane with the Run button
 * pinned to its bottom, right column is Results (same search + pagination toolbar convention as
 * Run/Dataset detail tables) -- shared by both tabs, showing whichever mode last completed a run.
 */

import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { createRowResultsPanel } from './rowResultsTable.js';
import { cloneCell, normalizeDatasetContent, isAssetCell } from './datasetContent.js';
import { prepareAssets } from './runClient.js';
import { getCurrentProjectId } from './currentProject.js';

/** Whether any cell in `rows` is an image/PDF reference -- if so, the backend needs a
 * project_session_id to resolve assetIds to real file paths before user code runs. */
function rowsHaveAssetCells(rows) {
  return (rows || []).some((row) => (row || []).some((cell) => isAssetCell(cell)));
}

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

const PROCESS_DF_CODE_FALLBACK = `def process(df):
    # df is the full dataset as a pandas DataFrame.
    # Return a DataFrame with the rows/columns you want, e.g.:
    #   df["col"] = df["col"].str.upper()   # transform a column
    #   return df[df["col"] > 0]            # conditional filter
    #   return df.sample(n=10)              # random sample
    return df
`;

/** Builds sample "Process as df" code listing the connected dataset's actual columns. */
function buildProcessDfDefaultCode(headers) {
  const cols = (Array.isArray(headers) ? headers : []).map((h) => String(h ?? ''));
  if (cols.length === 0) return PROCESS_DF_CODE_FALLBACK;
  return `def process(df):
${wrapCommentList('    # Columns: ', '    #   ', cols)}
    # Return a DataFrame with the rows/columns you want, e.g.:
    #   df["col"] = df["col"].str.upper()   # transform a column
    #   return df[df["col"] > 0]            # conditional filter
    #   return df.sample(n=10)              # random sample
    return df
`;
}

/** Turns the backend's list-of-row-dicts into a {headers, rows} table (union of keys, first-seen order). */
function rowsFromDicts(rowDicts) {
  const outputKeys = [];
  (rowDicts || []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    Object.keys(r).forEach((k) => { if (!outputKeys.includes(k)) outputKeys.push(k); });
  });
  const rows = (rowDicts || []).map((r) => outputKeys.map((k) => ((r && typeof r === 'object') ? cloneCell(r[k]) : '')));
  return normalizeDatasetContent({ headers: outputKeys, rows });
}

const PROCESS_POLL_INTERVAL_MS = 1200;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
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
  const savedDfCode = node?.dataset?.processDfCode;
  let activeMode = (node?.dataset?.processActiveMode === 'df') ? 'df' : 'row';

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
          <div class="review-detail-view-switch process-detail-view-switch" role="tablist" aria-label="Process by row or as a whole dataframe">
            <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active process-detail-tab" role="tab" aria-selected="true" data-process-tab="row">Process by row</button>
            <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab process-detail-tab" role="tab" aria-selected="false" data-process-tab="df">Process as dataframe</button>
          </div>
          <div class="process-detail-panels">
            <div class="process-detail-panel process-editor-mid" id="process-detail-panel-row">
              <div class="process-editor-host" id="process-editor-host"></div>
              <p class="process-editor-hint">Runs once per row of the connected dataset, using the Python interpreter set in Settings → Python. <code>row</code> is a dict keyed by the dataset's column names. Return value's keys become the output columns. Return nothing (or <code>None</code>) to skip a row.</p>
            </div>
            <div class="process-detail-panel process-editor-mid" id="process-detail-panel-df" hidden>
              <div class="process-editor-host" id="process-df-editor-host"></div>
              <p class="process-editor-hint">Runs once on the whole dataset, using the Python interpreter set in Settings → Python. <code>df</code> is a pandas DataFrame keyed by column name — requires pandas to be installed in that interpreter. Return a DataFrame.</p>
            </div>
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

  const tabBarEl = overlay.querySelector('.process-detail-view-switch');
  const rowPanelEl = overlay.querySelector('#process-detail-panel-row');
  const dfPanelEl = overlay.querySelector('#process-detail-panel-df');
  const editorHost = overlay.querySelector('#process-editor-host');
  const dfEditorHost = overlay.querySelector('#process-df-editor-host');
  const resultsContent = overlay.querySelector('.process-results-content');
  const runBtn = overlay.querySelector('.process-run-btn');

  const editorView = new EditorView({
    doc: (savedCode != null && savedCode !== '') ? savedCode : buildDefaultCode(getSourceDatasetContent().headers),
    extensions: [basicSetup, python()],
    parent: editorHost,
  });
  const dfEditorView = new EditorView({
    doc: (savedDfCode != null && savedDfCode !== '') ? savedDfCode : buildProcessDfDefaultCode(getSourceDatasetContent().headers),
    extensions: [basicSetup, python()],
    parent: dfEditorHost,
  });

  function getDfCode() {
    return dfEditorView.state.doc.toString();
  }

  function syncTabsUi() {
    tabBarEl?.querySelectorAll('[data-process-tab]').forEach((btn) => {
      const on = btn.getAttribute('data-process-tab') === activeMode;
      btn.classList.toggle('review-detail-tab--active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (rowPanelEl) rowPanelEl.hidden = activeMode !== 'row';
    if (dfPanelEl) dfPanelEl.hidden = activeMode !== 'df';
  }

  let running = false;
  let cancelled = false;
  let currentJobId = null;
  let dfRunning = false;
  let dfCurrentJobId = null;
  /** @type {{ headers: string[], rows: string[][] } | null} each mode keeps its own results, independently exportable. */
  let lastResults = null;
  let lastDfResults = null;
  let saveBtnEl = null;
  const progressBar = node?.querySelector?.('.workflow-node__process-progress') || null;

  function activeResults() {
    return activeMode === 'df' ? lastDfResults : lastResults;
  }

  function isActiveModeRunning() {
    return activeMode === 'df' ? dfRunning : running;
  }

  const resultsPanel = createRowResultsPanel({
    container: resultsContent,
    idPrefix: 'process',
    buildActions: (actions) => {
      saveBtnEl = document.createElement('button');
      saveBtnEl.type = 'button';
      saveBtnEl.className = 'btn btn-primary run-detail-save-to-workspace-btn process-save-btn';
      saveBtnEl.textContent = 'Export result';
      saveBtnEl.disabled = isActiveModeRunning() || !activeResults();
      saveBtnEl.addEventListener('click', () => {
        const results = activeResults();
        if (!results) return;
        const baseName = `${title} results`;
        const name = typeof getUniqueDatasetExportName === 'function' ? getUniqueDatasetExportName(baseName) : baseName;
        document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', {
          detail: {
            name,
            notes: `Exported from Process "${title}".`,
            headers: results.headers,
            rows: results.rows,
            processNodeId: node?.dataset?.nodeId || '',
          },
        }));
      });
      actions.appendChild(saveBtnEl);
    },
  });

  function getCode() {
    return editorView.state.doc.toString();
  }

  function setNodeProgress(completed, total) {
    if (!progressBar) return;
    const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    progressBar.style.width = pct + '%';
    progressBar.setAttribute('aria-valuenow', String(pct));
  }

  function persistRowResults(results) {
    if (!node?.dataset) return;
    if (results) node.dataset.processResults = JSON.stringify(results);
    else delete node.dataset.processResults;
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  function persistDfResults(results) {
    if (!node?.dataset) return;
    if (results) node.dataset.processDfResults = JSON.stringify(results);
    else delete node.dataset.processDfResults;
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  function showPlaceholder(text) {
    resultsPanel.showPlaceholder(text);
    saveBtnEl = null;
  }

  function showResultsCard(headers, rows, statusText) {
    resultsPanel.showResultsCard(headers, rows, statusText);
  }

  /** Re-renders the Results panel for whichever tab is active, from that tab's own last results.
   *  Replays the exact statusText saved alongside the results, rather than regenerating a
   *  differently-worded one -- otherwise "just finished" and "switched back to this tab" show
   *  different phrasing for the same result. */
  function refreshResultsForActiveMode() {
    const results = activeResults();
    if (results) {
      const n = results.rows.length;
      const statusText = results.statusText || `${n} row${n === 1 ? '' : 's'}.`;
      showResultsCard(results.headers, results.rows, statusText);
    } else {
      showPlaceholder('No results yet. Click Run.');
    }
  }

  function syncSaveButton() {
    if (saveBtnEl) saveBtnEl.disabled = isActiveModeRunning() || !activeResults();
  }

  function setTabsDisabled(disabled) {
    tabBarEl?.querySelectorAll('[data-process-tab]').forEach((btn) => { btn.disabled = disabled; });
  }

  function setRunningUi(isRunning) {
    running = isRunning;
    runBtn.textContent = isRunning ? 'Running, click to stop' : 'Run';
    runBtn.classList.toggle('btn-danger', isRunning);
    setTabsDisabled(isRunning);
    syncSaveButton();
  }

  function setDfRunningUi(isRunning) {
    dfRunning = isRunning;
    runBtn.textContent = isRunning ? 'Running, click to stop' : 'Run';
    runBtn.classList.toggle('btn-danger', isRunning);
    setTabsDisabled(isRunning);
    syncSaveButton();
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
    const succeededCount = perRow.length - errorCount;
    const skippedSuffix = skippedCount > 0 ? `, ${skippedCount} skipped` : '';
    let statusText;
    if (wasCancelled) {
      statusText = `Cancelled after ${outcomes.length}/${total} rows${skippedSuffix}.`;
    } else if (errorCount > 0) {
      statusText = `${succeededCount} succeeded, ${errorCount} failed${skippedSuffix} (of ${total}).`;
    } else if (skippedCount > 0) {
      statusText = `${succeededCount} rows processed${skippedSuffix} (of ${total}).`;
    } else {
      statusText = `${perRow.length} row${perRow.length === 1 ? '' : 's'} processed.`;
    }
    lastResults = perRow.length ? { headers, rows, statusText } : null;
    persistRowResults(lastResults);

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
      const session = rowsHaveAssetCells(inputRows) ? await prepareAssets(getCurrentProjectId()) : {};
      const res = await fetch(`${API_BASE}/api/process/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path: pythonPath, code: getCode(), headers: inputHeaders, rows: inputRows, ...session }),
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

  async function pollDfJob(jobId) {
    if (dfCurrentJobId !== jobId) return;
    let data;
    try {
      const res = await fetch(`${API_BASE}/api/process/df/run/result/${jobId}`);
      data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) throw new Error(data.detail || 'Failed to fetch results');
    } catch (e) {
      if (dfCurrentJobId !== jobId) return;
      setDfRunningUi(false);
      showPlaceholder((e && e.message) || 'Network error while checking progress.');
      return;
    }
    if (dfCurrentJobId !== jobId) return;
    if (data.status === 'running') {
      setTimeout(() => pollDfJob(jobId), PROCESS_POLL_INTERVAL_MS);
      return;
    }
    setDfRunningUi(false);
    if (data.error) {
      showPlaceholder(data.error);
      return;
    }
    const { headers: outHeaders, rows: outRows } = rowsFromDicts(data.rows);
    const n = outRows.length;
    const statusText = data.status === 'cancelled'
      ? `Cancelled. ${n} row${n === 1 ? '' : 's'} returned before stopping.`
      : `${n} row${n === 1 ? '' : 's'} returned.`;
    lastDfResults = outRows.length ? { headers: outHeaders, rows: outRows, statusText } : null;
    persistDfResults(lastDfResults);
    if (outRows.length) showResultsCard(outHeaders, outRows, statusText);
    else showPlaceholder('No rows returned.');
  }

  async function startDfRun() {
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

    setDfRunningUi(true);
    showPlaceholder('Running…');

    try {
      const session = rowsHaveAssetCells(inputRows) ? await prepareAssets(getCurrentProjectId()) : {};
      const res = await fetch(`${API_BASE}/api/process/df/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path: pythonPath, code: getDfCode(), headers: inputHeaders, rows: inputRows, ...session }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDfRunningUi(false);
        showPlaceholder(typeof data.detail === 'string' ? data.detail : 'Failed to start.');
        return;
      }
      dfCurrentJobId = data.job_id;
    } catch (e) {
      setDfRunningUi(false);
      showPlaceholder((e && e.message) || 'Network error.');
      return;
    }

    pollDfJob(dfCurrentJobId);
  }

  tabBarEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-process-tab]');
    if (!btn || btn.disabled) return;
    const tab = btn.getAttribute('data-process-tab');
    if (tab !== 'row' && tab !== 'df') return;
    activeMode = tab;
    syncTabsUi();
    refreshResultsForActiveMode();
  });

  runBtn.addEventListener('click', () => {
    if (activeMode === 'df') {
      if (dfRunning) {
        if (dfCurrentJobId) {
          fetch(`${API_BASE}/api/process/df/run/cancel/${dfCurrentJobId}`, { method: 'POST' }).catch(() => {});
        }
        return;
      }
      startDfRun();
      return;
    }
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
    if (node && node.dataset) {
      node.dataset.processCode = getCode();
      node.dataset.processDfCode = getDfCode();
      node.dataset.processActiveMode = activeMode;
    }
    if (running && currentJobId) {
      fetch(`${API_BASE}/api/process/run/cancel/${currentJobId}`, { method: 'POST' }).catch(() => {});
    }
    if (dfRunning && dfCurrentJobId) {
      fetch(`${API_BASE}/api/process/df/run/cancel/${dfCurrentJobId}`, { method: 'POST' }).catch(() => {});
    }
    currentJobId = null;
    dfCurrentJobId = null;
    editorView.destroy();
    dfEditorView.destroy();
    overlay.remove();
    document.body.style.overflow = '';
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);

  attachModalPaneCycle({
    overlay,
    bothLabel: 'Show both panels',
    leftOnlyLabel: 'Show code panel only',
    rightOnlyLabel: 'Show results panel only',
  });

  syncTabsUi();

  function restoreResults(key) {
    try {
      const raw = node?.dataset?.[key];
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && Array.isArray(parsed.headers) && Array.isArray(parsed.rows) && parsed.rows.length) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  lastResults = restoreResults('processResults');
  lastDfResults = restoreResults('processDfResults');
  refreshResultsForActiveMode();

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
