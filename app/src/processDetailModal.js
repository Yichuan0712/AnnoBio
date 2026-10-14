/**
 * Process node editor.
 *
 * Process nodes use one explicit contract: ``process(df, df_<name>, ...) -> DataFrame | {name: DataFrame}``.
 * `df` is its first input. Each other input is the parameter named after its readable alias
 * (processSignature.js). Inputs are connected on the canvas, through the node's ports, which follow
 * the parameters (nodePorts.js); this window lists them.
 */

import { EditorView, basicSetup } from 'codemirror';
import { Compartment } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { createRowResultsPanel } from './rowResultsTable.js';
import { resolveDataframeProcessCode } from './processCode.js';
import { renderSourceLink } from './nodeSourceLink.js';
import { buildDefaultProcessCode, isUntouchedSampleCode } from './processSampleCode.js';
import { attachRunHistoryPicker } from './runHistoryPicker.js';
import { executionIdleLabel } from './executionResumeState.js';

const API_BASE = BACKEND_API_BASE;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function normalizeResults(value) {
  if (!value || typeof value !== 'object') return null;
  const outputs = {};
  if (value.outputs && typeof value.outputs === 'object') {
    Object.entries(value.outputs).forEach(([name, result]) => {
      if (!name || !result || !Array.isArray(result.headers) || !Array.isArray(result.rows)) return;
      outputs[name] = { headers: result.headers, rows: result.rows };
    });
  } else if (Array.isArray(value.headers) && Array.isArray(value.rows)) {
    // Saved single-output results from earlier versions become the implicit result branch.
    outputs.result = { headers: value.headers, rows: value.rows };
  }
  return Object.keys(outputs).length ? { outputs, statusText: String(value.statusText || '') } : null;
}

function restoreResults(node, ...keys) {
  for (const key of keys) {
    try {
      const raw = node?.dataset?.[key];
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const normalized = normalizeResults(parsed);
      if (normalized) return normalized;
    } catch (_) {}
  }
  return null;
}

/**
 * @param {{ node: HTMLElement,
 *   getProcessInputs: (code: string) => { bindings: Array<{key: string, nodeId: string, kind: string, name: string, label: string, color?: string, content?: {headers: string[], rows: string[][]}, alias: string, primary: boolean, input: boolean, used: boolean}>, primaryDatasetId: string, savedAliases: Record<string, string> },
 *   syncProcessDependencies?: (code: string) => void,
 *   getInputRows?: (code: string) => Array<{ alias: string, nodeId: string, label: string, color: string }>,
 *   revealNode?: (nodeId: string) => void,
 *   getInputStatus?: () => { waiting: string, notices: string[] } }} options
 *   getProcessInputs: every Dataset and step output (stepInputs.js processInputBindings), marking the
 *   ones the code reads, by source key; a step output without a result yet has no content
 *   getInputRows: df and each parameter of `code`, with what is connected to it (empty label: nothing)
 */
export function openProcessDetailModal({ node, runProcessNode, getProcessInputs, syncProcessDependencies, getInputRows = () => [], revealNode = () => {}, getInputStatus, history = null }) {
  const nodeId = (node?.dataset?.nodeId ?? '').trim();
  const existing = nodeId
    ? document.querySelector(`.modal-overlay[data-process-node-id="${CSS.escape(nodeId)}"]`)
    : null;
  if (existing) {
    document.body.appendChild(existing);
    return;
  }

  const title = (node?.dataset?.processName || 'Process').trim() || 'Process';
  const readDatasets = (code) => {
    const raw = getProcessInputs?.(code) || {};
    const bindings = Array.isArray(raw.bindings) ? raw.bindings.filter((binding) => binding?.key) : [];
    const listedPrimary = bindings.some((binding) => binding.primary);
    return {
      bindings, primaryDatasetId: listedPrimary ? raw.primaryDatasetId : '',
      savedAliases: raw.savedAliases || {},
      // df reads a branch its Process no longer returns, so it is not listed; running says why.
      unlistedPrimary: !listedPrimary && !!raw.primaryDatasetId,
    };
  };
  const primaryHeaders = (code) => readDatasets(code).bindings.find((binding) => binding.primary)?.content?.headers || [];
  const initialCode = resolveDataframeProcessCode({
    dfCode: node?.dataset?.processDfCode,
    code: node?.dataset?.processCode,
  }) || buildDefaultProcessCode(primaryHeaders(''));
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
          <p class="run-detail-main-label">Code setup</p>
          <p class="run-detail-waiting-banner" role="status" hidden></p>
          <div class="dataset-meta-wrap process-input-wrap">
            <div class="modal-input-group">
              <div class="process-input-list modal-input-list" id="process-input-list"></div>
            </div>
          </div>
          <div class="process-editor-mid">
            <span class="dataset-meta-label">Python processing code</span>
            <div class="process-editor-host"></div>
            <p class="process-editor-hint">Runs once with the Python interpreter set in Settings &rarr; Python. <code>df</code> is the first input; other inputs correspond to the parameters in the code. Connect inputs on the canvas: drag an output onto a port of this node, or onto <code>+</code> to add one. Return one DataFrame, or a dictionary of named DataFrames to create branches.</p>
          </div>
          <div class="dataset-meta-field run-detail-model-actions-field">
            <div class="run-detail-llm-actions-row">
              <span class="run-detail-llm-actions-lead" aria-hidden="true"></span>
              <div class="run-detail-llm-actions-right"><button type="button" class="btn btn-primary run-detail-run-btn process-run-btn">Run code</button></div>
            </div>
            <p class="process-editor-hint process-upstream-notice" hidden></p>
          </div>
        </div>
        <div class="run-detail-preview-wrap">
          <div class="run-detail-preview-header">
            <h3 class="run-detail-preview-title">Results</h3>
            <div class="process-branch-picker" hidden></div>
          </div>
          <div class="run-detail-preview-content process-results-content"></div>
        </div>
      </div>
    </div>
  `;

  const editorHost = overlay.querySelector('.process-editor-host');
  const resultsContent = overlay.querySelector('.process-results-content');
  const branchPicker = overlay.querySelector('.process-branch-picker');
  const runBtn = overlay.querySelector('.process-run-btn');
  const upstreamNoticeEl = overlay.querySelector('.process-upstream-notice');
  const waitingBannerEl = overlay.querySelector('.run-detail-waiting-banner');
  const editable = new Compartment();
  const editorView = new EditorView({
    doc: initialCode,
    extensions: [basicSetup, python(), editable.of(EditorView.editable.of(true)), EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // A df_<name> the code now names shows up as an input.
      clearTimeout(inputsRefreshTimer);
      inputsRefreshTimer = setTimeout(renderInputRows, 150);
      if (!history) return;
      node.dataset.processDfCode = update.state.doc.toString();
      scheduleHistoryRefresh();
    })],
    parent: editorHost,
  });
  const getCode = () => editorView.state.doc.toString();
  /** One edit covering only what changed, so the cursor and undo history stay where they were. */
  function replaceCode(nextCode) {
    const code = getCode();
    if (nextCode === code) return;
    let from = 0;
    while (from < code.length && from < nextCode.length && code[from] === nextCode[from]) from += 1;
    let end = 0;
    while (end < code.length - from && end < nextCode.length - from
      && code[code.length - 1 - end] === nextCode[nextCode.length - 1 - end]) end += 1;
    editorView.dispatch({ changes: { from, to: code.length - end, insert: nextCode.slice(from, nextCode.length - end) } });
  }
  if (history) node.dataset.processDfCode = getCode();
  let historyRefreshTimer = null;
  let inputsRefreshTimer = null;
  function scheduleHistoryRefresh() {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(() => { void refreshHistoryState(); }, 150);
  }

  /** Each data input, with a link to its source on the canvas. */
  function renderInputRows() {
    const list = overlay.querySelector('#process-input-list');
    list.replaceChildren(...getInputRows(getCode()).map((row) => {
      const item = document.createElement('div');
      item.className = 'process-input-row';
      const label = document.createElement('span');
      label.className = 'dataset-meta-label';
      label.textContent = 'Data Input';
      const source = document.createElement('div');
      source.className = 'node-source';
      renderSourceLink(source, {
        label: row.label, color: row.color,
        hint: row.alias === 'df' ? 'Not connected: drag an output onto df on the canvas.' : 'Not connected: drag an output onto this port on the canvas.',
        onReveal: () => {
          close();
          revealNode(row.nodeId);
        },
      });
      item.append(label, source);
      return item;
    }));
  }
  renderInputRows();

  let running = false;
  let currentJobId = null;
  let currentHistoryStatus = '';
  let lastResults = restoreResults(node, 'processDfResults', 'processResults');
  let lastError = '';
  let activeBranchName = '';
  let saveBtnEl = null;

  function updateActionEmphasis() {
    const hasVisibleResults = Boolean(saveBtnEl && !lastError);
    runBtn.classList.toggle('btn-primary', !hasVisibleResults && !running);
    runBtn.classList.toggle('btn-secondary', hasVisibleResults || running);
  }

  const resultsPanel = createRowResultsPanel({
    container: resultsContent,
    idPrefix: 'process',
    buildActions: (actions) => {
      saveBtnEl = document.createElement('button');
      saveBtnEl.type = 'button';
      saveBtnEl.className = 'btn btn-primary run-detail-save-to-workspace-btn process-save-btn';
      saveBtnEl.textContent = 'Create dataset';
      saveBtnEl.disabled = running || !lastResults;
      saveBtnEl.addEventListener('click', createBranchDatasets);
      actions.appendChild(saveBtnEl);
    },
  });

  function showPlaceholder(message) {
    resultsPanel.showPlaceholder(message);
    saveBtnEl = null;
    updateActionEmphasis();
  }

  function showError(error) {
    lastError = String(error?.message || error || 'Process failed.');
    branchPicker.hidden = true;
    resultsPanel.showError(lastError, `Process "${title}" failed`);
    saveBtnEl = null;
    updateActionEmphasis();
  }

  function refreshResults() {
    if (lastError) {
      showError(lastError);
      return;
    }
    if (!lastResults) {
      branchPicker.hidden = true;
      showPlaceholder('No results yet. Click Run code.');
      return;
    }
    const entries = Object.entries(lastResults.outputs);
    if (!entries.length) {
      branchPicker.hidden = true;
      showPlaceholder('No branches returned.');
      return;
    }
    if (!lastResults.outputs[activeBranchName]) activeBranchName = entries[0][0];
    const [branchName, branch] = [activeBranchName, lastResults.outputs[activeBranchName]];
    branchPicker.hidden = entries.length < 2;
    if (!branchPicker.hidden) {
      branchPicker.innerHTML = `<label class="dataset-detail-search-label" for="process-branch-select">Branch</label><select id="process-branch-select" class="dataset-detail-rows-select" aria-label="Process result branch">${entries.map(([name, output]) => `<option value="${escapeHtml(name)}" ${name === branchName ? 'selected' : ''}>${escapeHtml(name)} (${output.rows.length})</option>`).join('')}</select>`;
      branchPicker.querySelector('select').addEventListener('change', (event) => {
        activeBranchName = event.target.value;
        refreshResults();
      });
    }
    resultsPanel.showResultsCard(
      branch.headers,
      branch.rows,
      `${branch.headers.length} columns, ${branch.rows.length} rows`,
    );
    if (saveBtnEl) saveBtnEl.textContent = entries.length > 1 ? 'Create branch datasets' : 'Create dataset';
    updateActionEmphasis();
  }

  function createBranchDatasets() {
    if (!lastResults) return;
    // The same Datasets as the context menu's Create dataset (savedDatasets.js).
    document.dispatchEvent(new CustomEvent('workflow:save-process-output', { detail: { processNodeId: node?.dataset?.nodeId || '' } }));
  }

  function setRunningUi(isRunning) {
    running = isRunning;
    editorView.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!isRunning)) });
    runBtn.textContent = isRunning ? 'Stop processing'
      : currentHistoryStatus === 'completed'
        ? 'Run code again'
        : executionIdleLabel({ task: 'processing', interrupted: node?.dataset?.processResumable === '1' });
    runBtn.classList.toggle('btn-danger', isRunning);
    if (saveBtnEl) saveBtnEl.disabled = isRunning || !lastResults;
    updateActionEmphasis();
  }

  async function refreshHistoryState() {
    if (!history || running || !overlay.isConnected) return;
    try {
      const { entries, currentId } = await history.loadEntries();
      const current = entries.find((entry) => entry.id === currentId);
      if (!overlay.isConnected || running) return;
      currentHistoryStatus = current?.status || '';
      runBtn.disabled = current?.status === 'running';
      runBtn.textContent = current?.status === 'running' ? 'Processing…'
        : current?.status === 'completed' ? 'Run code again' : executionIdleLabel({
        task: 'processing',
        interrupted: current?.status === 'stopped',
        failed: current?.status === 'failed',
      });
      lastResults = restoreResults(node, 'processDfResults', 'processResults');
      lastError = current?.status === 'failed' ? String(current.error || 'Process failed.') : '';
      refreshResults();
      refreshUpstreamState();
    } catch (_) { /* startRun reports storage errors when used */ }
  }

  /**
   * An input without a complete result yet blocks Run and is named in the banner; failed upstream
   * rows are noted (docs/design/DATA_FLOW_DESIGN.md §3.7).
   */
  function refreshUpstreamState() {
    const status = getInputStatus?.() || { waiting: '', notices: [] };
    waitingBannerEl.textContent = status.waiting;
    waitingBannerEl.hidden = !status.waiting;
    upstreamNoticeEl.textContent = status.notices.join(' ');
    upstreamNoticeEl.hidden = !status.notices.length;
    if (running) return;
    if (status.waiting) {
      runBtn.disabled = true;
      runBtn.textContent = 'Waiting for upstream';
    } else if (runBtn.textContent === 'Waiting for upstream') {
      runBtn.disabled = false;
      runBtn.textContent = currentHistoryStatus === 'completed' ? 'Run code again' : executionIdleLabel({ task: 'processing', interrupted: node?.dataset?.processResumable === '1' });
    }
  }

  async function startRun() {
    const { bindings, unlistedPrimary } = readDatasets(getCode());
    const primary = bindings.find((binding) => binding.primary);
    if (!primary && !unlistedPrimary) {
      showPlaceholder("Drag a Dataset or a step output onto this Process's df port on the canvas.");
      return;
    }
    node.dataset.processDfCode = getCode();
    node.dataset.processActiveMode = 'df';
    delete node.dataset.processCode;
    syncProcessDependencies?.(getCode());
    lastError = '';
    setRunningUi(true);
    showPlaceholder('Running…');
    try {
      await runProcessNode(nodeId, {
        timeoutMs: 0,
        onStarted: (jobId) => {
          currentJobId = jobId;
          if (cancelRequested) cancelJob(jobId);
        },
      });
      lastResults = restoreResults(node, 'processDfResults', 'processResults');
      currentHistoryStatus = 'completed';
      if (overlay.isConnected) {
        if (lastResults) refreshResults();
        else showPlaceholder('No rows returned.');
      }
    } catch (error) {
      currentHistoryStatus = 'failed';
      if (overlay.isConnected) showError(error);
    } finally {
      currentJobId = null;
      cancelRequested = false;
      if (overlay.isConnected) {
        setRunningUi(false);
        refreshUpstreamState();
      }
    }
  }

  // An upstream step finishing elsewhere lets this one run.
  const onHistoryResolved = () => { if (overlay.isConnected) refreshUpstreamState(); };
  document.addEventListener('workflow:history-resolved', onHistoryResolved);

  const cancelJob = (jobId) => fetch(`${API_BASE}/api/process/df/run/cancel/${jobId}`, { method: 'POST' }).catch(() => {});
  let cancelRequested = false;
  runBtn.addEventListener('click', () => {
    if (running) {
      cancelRequested = true;
      if (currentJobId) cancelJob(currentJobId);
      return;
    }
    void startRun();
  });

  function close({ discard = false } = {}) {
    clearTimeout(historyRefreshTimer);
    clearTimeout(inputsRefreshTimer);
    document.removeEventListener('workflow:history-resolved', onHistoryResolved);
    if (!discard && node?.dataset) {
      node.dataset.processDfCode = getCode();
      node.dataset.processActiveMode = 'df';
      delete node.dataset.processCode;
      syncProcessDependencies?.(getCode());
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    if (running) {
      cancelRequested = true;
      if (currentJobId) cancelJob(currentJobId);
    }
    editorView.destroy();
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  attachModalPaneCycle({ overlay, bothLabel: 'Show both panels', leftOnlyLabel: 'Show code setup panel only', rightOnlyLabel: 'Show results panel only' });
  if (history) attachRunHistoryPicker({
    overlay, loadEntries: history.loadEntries,
    onSelect: (recordId) => history.select(recordId, () => close({ discard: true })),
    onDelete: history.delete,
    isDisabled: () => running,
  });
  refreshResults();
  if (node?.dataset?.processResumable === '1') runBtn.textContent = 'Resume processing';
  refreshUpstreamState();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  if (history) void refreshHistoryState();
}
