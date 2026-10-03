/**
 * Process node editor.
 *
 * Process nodes use one explicit contract: ``process(df) -> DataFrame | {name: DataFrame}``.
 * `df` is its primary Dataset. Other canvas Datasets are exposed by readable aliases and become
 * explicit canvas dependencies only when the Process code references them.
 */

import { EditorView, basicSetup } from 'codemirror';
import { Compartment } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { createRowResultsPanel } from './rowResultsTable.js';
import { resolveDataframeProcessCode } from './processCode.js';
import { bindNodePicker, nodePickerHtml } from './nodePicker.js';
import { buildProcessDatasetBindings } from './processDatasetBindings.js';
import { openProcessDatasetsDialog } from './processDatasetsDialog.js';
import { attachRunHistoryPicker } from './runHistoryPicker.js';
import { executionIdleLabel } from './executionResumeState.js';

const API_BASE = BACKEND_API_BASE;
const MAX_COMMENT_LINE_CHARS = 70;

function wrapCommentList(prefix, continuationPrefix, items) {
  const lines = [];
  let current = prefix;
  items.forEach((item, index) => {
    const piece = (index === 0 ? '' : ', ') + item;
    if (current !== prefix && current.length + piece.length > MAX_COMMENT_LINE_CHARS) {
      lines.push(current);
      current = continuationPrefix + item;
    } else current += piece;
  });
  lines.push(current);
  return lines.join('\n');
}

/** Sample code naming the primary Dataset's real columns. Comments must not spell a real df_<name>
 * alias: referencedDatasetAliases scans comments too, so that would add a canvas dependency. */
function buildDefaultCode(headers) {
  const columns = (Array.isArray(headers) ? headers : []).map((header) => String(header ?? '')).filter(Boolean);
  const col = JSON.stringify(columns[0] || 'column');
  const columnLines = columns.length
    ? wrapCommentList('    # Columns: ', '    #   ', columns)
    : '    # Columns: (none yet)';
  return `import pandas as pd


def process(df):
    # df is this Process's input Dataset as a pandas DataFrame.
${columnLines}
    # Other canvas Datasets are available as df_<name> (see "View available
    # datasets"); using one in this code links it to this Process on the canvas.
    #
    # Return one of:
    #   1. One DataFrame -> one output Dataset
    #        return df[df[${col}].notna()]
    #   2. A dict of DataFrames -> one output Dataset per key (named branches)
    #        mask = df[${col}].astype(str).str.len() > 0
    #        return {"kept": df[mask], "empty": df[~mask]}
    #
    # Common steps:
    #   df[${col}] = df[${col}].astype(str).str.strip()  # clean a column
    #   df = df.drop_duplicates(subset=[${col}])  # remove duplicates
    #   df = df.merge(df_<name>, on=${col}, how="left")  # join another Dataset
    return df
`;
}

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
 * @param {{ node: HTMLElement, getProcessDatasets: () => { datasets: Array<{nodeId: string, name: string, color?: string, content: {headers: string[], rows: string[][]}}>, primaryDatasetId: string }, syncProcessDependencies?: (code: string) => void, setPrimaryDataset?: (datasetNodeId: string, code: string) => void, getUniqueDatasetExportName?: (base: string) => string }} options
 *   setPrimaryDataset: the Process picks its df Dataset in this window, like a Run picks its Prompt
 */
export function openProcessDetailModal({ node, runProcessNode, getProcessDatasets, syncProcessDependencies, setPrimaryDataset, getUniqueDatasetExportName, history = null }) {
  const nodeId = (node?.dataset?.nodeId ?? '').trim();
  const existing = nodeId
    ? document.querySelector(`.modal-overlay[data-process-node-id="${CSS.escape(nodeId)}"]`)
    : null;
  if (existing) {
    document.body.appendChild(existing);
    return;
  }

  const title = (node?.dataset?.processName || 'Process').trim() || 'Process';
  const readDatasets = () => {
    const raw = getProcessDatasets?.() || {};
    const datasets = Array.isArray(raw.datasets) ? raw.datasets.filter((dataset) => dataset?.nodeId && dataset?.content) : [];
    const primaryDatasetId = datasets.some((dataset) => dataset.nodeId === raw.primaryDatasetId)
      ? raw.primaryDatasetId
      : '';
    return { bindings: buildProcessDatasetBindings(datasets, primaryDatasetId), primaryDatasetId };
  };
  const initialDatasets = readDatasets();
  const primaryInput = initialDatasets.bindings.find((binding) => binding.primary);
  const initialCode = resolveDataframeProcessCode({
    dfCode: node?.dataset?.processDfCode,
    code: node?.dataset?.processCode,
  }) || buildDefaultCode(primaryInput?.content?.headers || []);
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
          <div class="dataset-meta-wrap process-input-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="process-primary-picker">Input dataset</label>
              ${nodePickerHtml({ id: 'process-primary-picker', placeholder: 'Select input dataset', ariaLabel: 'Select input dataset' })}
            </div>
          </div>
          <div class="process-editor-mid">
            <div class="process-editor-host"></div>
          <p class="process-editor-hint">Runs once with the Python interpreter set in Settings &rarr; Python. <code>df</code> is the Input dataset. Referencing another alias automatically creates its canvas dependency. Return one DataFrame, or a dictionary of named DataFrames to create branches.</p>
          <button type="button" class="process-dataset-bindings-toggle" aria-haspopup="dialog">View available datasets</button>
          </div>
          <div class="dataset-meta-field run-detail-model-actions-field">
            <div class="run-detail-llm-actions-row">
              <span class="run-detail-llm-actions-lead" aria-hidden="true"></span>
              <div class="run-detail-llm-actions-right"><button type="button" class="btn btn-secondary run-detail-run-btn process-run-btn">Run</button></div>
            </div>
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
  const datasetBindingsToggle = overlay.querySelector('.process-dataset-bindings-toggle');
  const runBtn = overlay.querySelector('.process-run-btn');
  let closeDatasetsDialog = null;
  datasetBindingsToggle.addEventListener('click', () => {
    closeDatasetsDialog?.();
    closeDatasetsDialog = openProcessDatasetsDialog(readDatasets().bindings);
  });
  const editable = new Compartment();
  const editorView = new EditorView({
    doc: initialCode,
    extensions: [basicSetup, python(), editable.of(EditorView.editable.of(true)), EditorView.updateListener.of((update) => {
      if (!update.docChanged || !history) return;
      node.dataset.processDfCode = update.state.doc.toString();
      scheduleHistoryRefresh();
    })],
    parent: editorHost,
  });
  const getCode = () => editorView.state.doc.toString();
  if (history) node.dataset.processDfCode = getCode();
  let historyRefreshTimer = null;
  function scheduleHistoryRefresh() {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(() => { void refreshHistoryState(); }, 150);
  }

  // Same picker as a Run window's Input dataset.
  const primaryPicker = bindNodePicker(overlay.querySelector('#process-primary-picker'), {
    placeholder: 'Select input dataset',
    getOptions: () => readDatasets().bindings.map(({ nodeId, name, color }) => ({ nodeId, name, color })),
    getValue: () => readDatasets().primaryDatasetId,
    onSelect: (datasetNodeId) => {
      const previousDefault = buildDefaultCode(readDatasets().bindings.find((binding) => binding.primary)?.content?.headers || []);
      const code = getCode();
      setPrimaryDataset?.(datasetNodeId, code);
      // Untouched sample code follows the new Dataset's columns; edited code is left alone.
      if (code === previousDefault) {
        const nextDefault = buildDefaultCode(readDatasets().bindings.find((binding) => binding.primary)?.content?.headers || []);
        editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: nextDefault } });
      }
      if (history) scheduleHistoryRefresh();
    },
    isLocked: () => running,
    closeWithin: overlay,
  });
  let running = false;
  let currentJobId = null;
  let currentHistoryStatus = '';
  let completedActionHovered = false;
  let lastResults = restoreResults(node, 'processDfResults', 'processResults');
  let activeBranchName = '';
  let saveBtnEl = null;

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
  }

  function refreshResults() {
    if (!lastResults) {
      branchPicker.hidden = true;
      showPlaceholder('No results yet. Click Run.');
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
  }

  function createBranchDatasets() {
    if (!lastResults) return;
    const entries = Object.entries(lastResults.outputs);
    const processLeft = parseFloat(node?.style?.left || '') || 0;
    const processTop = parseFloat(node?.style?.top || '') || 0;
    const processWidth = node?.offsetWidth || 160;
    entries.forEach(([branchName, output], index) => {
      const baseName = entries.length === 1 ? `${title} results` : `${title} — ${branchName}`;
      const name = typeof getUniqueDatasetExportName === 'function' ? getUniqueDatasetExportName(baseName) : baseName;
      document.dispatchEvent(new CustomEvent('workflow:add-dataset-node', {
        detail: {
          name,
          notes: `Branch "${branchName}" exported from Process "${title}".`,
          headers: output.headers,
          rows: output.rows,
          processNodeId: node?.dataset?.nodeId || '',
          processOutputName: branchName,
          left: processLeft + processWidth + 56,
          top: processTop + index * 132,
        },
      }));
    });
  }

  function setRunningUi(isRunning) {
    running = isRunning;
    primaryPicker.setLocked(isRunning);
    editorView.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!isRunning)) });
    runBtn.textContent = isRunning ? 'Running, click to stop'
      : currentHistoryStatus === 'completed'
        ? (completedActionHovered ? 'Run again' : 'Run completed')
        : executionIdleLabel({ interrupted: node?.dataset?.processResumable === '1' });
    runBtn.classList.toggle('btn-danger', isRunning);
    if (saveBtnEl) saveBtnEl.disabled = isRunning || !lastResults;
  }

  async function refreshHistoryState() {
    if (!history || running || !overlay.isConnected) return;
    try {
      const { entries, currentId } = await history.loadEntries();
      const current = entries.find((entry) => entry.id === currentId);
      if (!overlay.isConnected || running) return;
      currentHistoryStatus = current?.status || '';
      runBtn.disabled = current?.status === 'running';
      runBtn.textContent = current?.status === 'running' ? 'Runningâ€¦'
        : current?.status === 'completed' ? (completedActionHovered ? 'Run again' : 'Run completed') : executionIdleLabel({
        interrupted: current?.status === 'stopped',
        failed: current?.status === 'failed',
      });
      lastResults = restoreResults(node, 'processDfResults', 'processResults');
      refreshResults();
    } catch (_) { /* startRun reports storage errors when used */ }
  }

  const showCompletedAction = () => {
    completedActionHovered = true;
    if (!running && currentHistoryStatus === 'completed') runBtn.textContent = 'Run again';
  };
  const hideCompletedAction = () => {
    completedActionHovered = false;
    if (!running && currentHistoryStatus === 'completed') runBtn.textContent = 'Run completed';
  };
  runBtn.addEventListener('mouseenter', showCompletedAction);
  runBtn.addEventListener('mouseleave', hideCompletedAction);
  runBtn.addEventListener('focus', showCompletedAction);
  runBtn.addEventListener('blur', hideCompletedAction);

  async function startRun() {
    const { bindings } = readDatasets();
    const primary = bindings.find((binding) => binding.primary);
    if (!primary) {
      showPlaceholder('Choose an Input dataset before running.');
      primaryPicker.focus();
      return;
    }
    node.dataset.processDfCode = getCode();
    node.dataset.processActiveMode = 'df';
    delete node.dataset.processCode;
    syncProcessDependencies?.(getCode());
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
      if (overlay.isConnected) {
        if (lastResults) refreshResults();
        else showPlaceholder('No rows returned.');
      }
    } catch (error) {
      if (overlay.isConnected) showPlaceholder(error?.message || 'Process failed.');
    } finally {
      currentJobId = null;
      cancelRequested = false;
      if (overlay.isConnected) {
        setRunningUi(false);
        if (history) void refreshHistoryState();
      }
    }
  }

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
    closeDatasetsDialog?.();
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
  if (node?.dataset?.processResumable === '1') runBtn.textContent = 'Resume';
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  if (history) void refreshHistoryState();
}
