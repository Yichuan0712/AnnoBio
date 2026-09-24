/**
 * Process node editor.
 *
 * Process nodes use one explicit contract: ``process(df) -> DataFrame | {name: DataFrame}``.
 * `df` is its primary Dataset. Other canvas Datasets are exposed by readable aliases and become
 * explicit canvas dependencies only when the Process code references them.
 */

import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { attachModalPaneCycle } from './paneToggleButton.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { createRowResultsPanel } from './rowResultsTable.js';
import { cloneCell, normalizeDatasetContent, isAssetCell } from './datasetContent.js';
import { prepareAssets } from './runClient.js';
import { getCurrentProjectId } from './currentProject.js';
import { resolveDataframeProcessCode } from './processCode.js';
import { buildProcessDatasetBindings } from './processDatasetBindings.js';

const API_BASE = BACKEND_API_BASE;
const PROCESS_POLL_INTERVAL_MS = 1200;
const MAX_COMMENT_LINE_CHARS = 70;
const FALLBACK_DEFAULT_CODE = `def process(df):
    # df is this Process's primary Dataset.
    # Return a DataFrame with the rows and columns you want to keep.
    # Or return {"accepted": df_a, "needs_review": df_b} to create named branches.
    return df
`;

function rowsHaveAssetCells(rows) {
  return (rows || []).some((row) => (row || []).some((cell) => isAssetCell(cell)));
}

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

function buildDefaultCode(headers) {
  const columns = (Array.isArray(headers) ? headers : []).map((header) => String(header ?? ''));
  if (!columns.length) return FALLBACK_DEFAULT_CODE;
  return `def process(df):
${wrapCommentList('    # Columns: ', '    #   ', columns)}
    # Return a DataFrame. Examples:
    #   df["column"] = df["column"].astype(str).str.strip()
    #   return df[df["column"].notna()]  # filter rows
    #   return {"accepted": df[df["score"] >= 0.8], "rejected": df[df["score"] < 0.8]}
    return df
`;
}

function rowsFromDicts(rowDicts) {
  const outputKeys = [];
  (rowDicts || []).forEach((row) => {
    if (!row || typeof row !== 'object') return;
    Object.keys(row).forEach((key) => { if (!outputKeys.includes(key)) outputKeys.push(key); });
  });
  const rows = (rowDicts || []).map((row) => outputKeys.map((key) => (
    row && typeof row === 'object' ? cloneCell(row[key]) : ''
  )));
  return normalizeDatasetContent({ headers: outputKeys, rows });
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    throw new Error('Clipboard API is unavailable');
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  }
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
 * @param {{ node: HTMLElement, getProcessDatasets: () => { datasets: Array<{nodeId: string, name: string, color?: string, content: {headers: string[], rows: string[][]}}>, primaryDatasetId: string }, syncProcessDependencies?: (code: string) => void, getUniqueDatasetExportName?: (base: string) => string }} options
 */
export function openProcessDetailModal({ node, getProcessDatasets, syncProcessDependencies, getUniqueDatasetExportName }) {
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
      : (datasets[0]?.nodeId || '');
    return { bindings: buildProcessDatasetBindings(datasets, primaryDatasetId), primaryDatasetId };
  };
  const initialDatasets = readDatasets();
  const primaryInput = initialDatasets.bindings.find((binding) => binding.primary);
  const datasetBindings = initialDatasets.bindings.map((binding) => `
    <button type="button" class="process-dataset-menu__item" data-copy-alias="${escapeHtml(binding.alias)}" title="Copy ${escapeHtml(binding.alias)}">
      <span class="run-detail-ws-option-color" style="background: ${escapeHtml(binding.color || '#7b61ff')}"></span>
      <span class="process-dataset-menu__name">${escapeHtml(binding.name || 'Dataset')}${binding.primary ? '<span class="process-dataset-menu__primary">This Process</span>' : ''}</span>
      <code class="process-dataset-menu__alias">${escapeHtml(binding.alias)}</code>
      <span class="process-dataset-menu__copy" aria-hidden="true">Copy</span>
    </button>
  `).join('') || '<p class="process-dataset-menu__empty">No Dataset is available.</p>';
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
          <p class="run-detail-main-label">Python code</p>
          <div class="process-editor-mid">
            <div class="process-editor-host"></div>
          <p class="process-editor-hint">Runs once with the Python interpreter set in Settings &rarr; Python. <code>df</code> is this Process's Dataset. Referencing another alias automatically creates its canvas dependency. Return one DataFrame, or a dictionary of named DataFrames to create branches.</p>
          <button type="button" class="process-dataset-bindings-toggle" aria-expanded="false">View available datasets <span aria-hidden="true">&dtrif;</span></button>
          <div class="process-dataset-menu" hidden>${datasetBindings}</div>
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
  const datasetBindingsEl = overlay.querySelector('.process-dataset-menu');
  const datasetBindingsToggle = overlay.querySelector('.process-dataset-bindings-toggle');
  const runBtn = overlay.querySelector('.process-run-btn');
  function positionDatasetMenu() {
    if (datasetBindingsEl.hidden) return;
    const triggerRect = datasetBindingsToggle.getBoundingClientRect();
    const menuHeight = Math.min(datasetBindingsEl.scrollHeight, 218);
    const showAbove = window.innerHeight - triggerRect.bottom < menuHeight + 10 && triggerRect.top > menuHeight + 10;
    datasetBindingsEl.style.left = `${Math.max(8, Math.min(triggerRect.left, window.innerWidth - 408))}px`;
    datasetBindingsEl.style.top = `${showAbove ? triggerRect.top - menuHeight - 6 : triggerRect.bottom + 6}px`;
  }
  datasetBindingsToggle?.addEventListener('click', () => {
    const nextHidden = !datasetBindingsEl.hidden;
    datasetBindingsEl.hidden = nextHidden;
    datasetBindingsToggle.setAttribute('aria-expanded', String(!nextHidden));
    datasetBindingsToggle.innerHTML = nextHidden
      ? 'View available datasets <span aria-hidden="true">&dtrif;</span>'
      : 'View available datasets <span aria-hidden="true">&utrif;</span>';
    positionDatasetMenu();
  });
  overlay.addEventListener('mousedown', (event) => {
    if (datasetBindingsEl.hidden || event.target.closest('.process-dataset-menu, .process-dataset-bindings-toggle')) return;
    datasetBindingsEl.hidden = true;
    datasetBindingsToggle.setAttribute('aria-expanded', 'false');
    datasetBindingsToggle.innerHTML = 'View available datasets <span aria-hidden="true">&dtrif;</span>';
  });
  window.addEventListener('resize', positionDatasetMenu);
  datasetBindingsEl?.addEventListener('click', async (event) => {
    const item = event.target.closest('.process-dataset-menu__item');
    const alias = item?.dataset?.copyAlias;
    if (!alias) return;
    const label = item.querySelector('.process-dataset-menu__copy');
    const originalText = label?.textContent || 'Copy';
    const copied = await copyText(alias);
    if (!label) return;
    label.textContent = copied ? 'Copied' : 'Copy failed';
    window.setTimeout(() => { label.textContent = originalText; }, 1200);
  });
  const editorView = new EditorView({ doc: initialCode, extensions: [basicSetup, python()], parent: editorHost });
  const getCode = () => editorView.state.doc.toString();
  let running = false;
  let currentJobId = null;
  let lastResults = restoreResults(node, 'processDfResults', 'processResults');
  let activeBranchName = '';
  let saveBtnEl = null;
  const progressBar = node?.querySelector?.('.workflow-node__process-progress') || null;

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

  function setNodeProgress(completed, total) {
    if (!progressBar) return;
    const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute('aria-valuenow', String(percent));
  }

  function setRunningUi(isRunning) {
    running = isRunning;
    runBtn.textContent = isRunning ? 'Running, click to stop' : 'Run';
    runBtn.classList.toggle('btn-danger', isRunning);
    if (saveBtnEl) saveBtnEl.disabled = isRunning || !lastResults;
  }

  function persistResults(results) {
    if (!node?.dataset) return;
    if (results) node.dataset.processDfResults = JSON.stringify(results);
    else delete node.dataset.processDfResults;
    delete node.dataset.processResults;
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  async function pollJob(jobId) {
    if (currentJobId !== jobId) return;
    let data;
    try {
      const response = await fetch(`${API_BASE}/api/process/df/run/result/${jobId}`);
      data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 202) throw new Error(data.detail || 'Failed to fetch results');
    } catch (error) {
      if (currentJobId !== jobId) return;
      setRunningUi(false);
      showPlaceholder(error?.message || 'Network error while checking progress.');
      return;
    }
    if (currentJobId !== jobId) return;
    if (data.status === 'running') {
      setTimeout(() => pollJob(jobId), PROCESS_POLL_INTERVAL_MS);
      return;
    }
    setRunningUi(false);
    if (data.error) {
      showPlaceholder(data.error);
      return;
    }
    const outputs = {};
    Object.entries(data.outputs || {}).forEach(([branchName, rowDicts]) => {
      const { headers, rows } = rowsFromDicts(rowDicts);
      outputs[branchName] = { headers, rows };
    });
    setNodeProgress(1, 1);
    const branchCount = Object.keys(outputs).length;
    const statusText = data.status === 'cancelled'
      ? `Cancelled. ${branchCount} branch${branchCount === 1 ? '' : 'es'} returned before stopping.`
      : `${branchCount} branch${branchCount === 1 ? '' : 'es'} returned.`;
    lastResults = branchCount ? { outputs, statusText } : null;
    persistResults(lastResults);
    if (lastResults) refreshResults();
    else showPlaceholder('No rows returned.');
  }

  async function startRun() {
    const { bindings } = readDatasets();
    const primary = bindings.find((binding) => binding.primary);
    const { headers = [], rows = [] } = primary?.content || {};
    if (!primary) {
      showPlaceholder('Connect a primary Dataset before running.');
      return;
    }
    let pythonPath = '';
    try {
      const response = await fetch(`${API_BASE}/api/settings`);
      const settings = response.ok ? await response.json() : null;
      pythonPath = String(settings?.python_path || '').trim();
    } catch (_) {}
    if (!pythonPath) {
      showPlaceholder('Set a Python interpreter path in Settings → Python first.');
      return;
    }
    setRunningUi(true);
    setNodeProgress(0, rows.length);
    showPlaceholder('Running…');
    try {
      const allRows = bindings.flatMap((binding) => binding.content?.rows || []);
      const session = rowsHaveAssetCells(allRows) ? await prepareAssets(getCurrentProjectId()) : {};
      const inputDatasets = Object.fromEntries(bindings.map((binding) => [binding.alias, binding.content]));
      const response = await fetch(`${API_BASE}/api/process/df/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ python_path: pythonPath, code: getCode(), headers, rows, input_datasets: inputDatasets, primary_dataset_id: 'df', ...session }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setRunningUi(false);
        showPlaceholder(typeof data.detail === 'string' ? data.detail : 'Failed to start.');
        return;
      }
      currentJobId = data.job_id;
      pollJob(currentJobId);
    } catch (error) {
      setRunningUi(false);
      showPlaceholder(error?.message || 'Network error.');
    }
  }

  runBtn.addEventListener('click', () => {
    if (running) {
      if (currentJobId) fetch(`${API_BASE}/api/process/df/run/cancel/${currentJobId}`, { method: 'POST' }).catch(() => {});
      return;
    }
    void startRun();
  });

  function close() {
    window.removeEventListener('resize', positionDatasetMenu);
    if (node?.dataset) {
      node.dataset.processDfCode = getCode();
      node.dataset.processActiveMode = 'df';
      delete node.dataset.processCode;
      syncProcessDependencies?.(getCode());
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    if (running && currentJobId) fetch(`${API_BASE}/api/process/df/run/cancel/${currentJobId}`, { method: 'POST' }).catch(() => {});
    currentJobId = null;
    editorView.destroy();
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  attachModalPaneCycle({ overlay, bothLabel: 'Show both panels', leftOnlyLabel: 'Show code panel only', rightOnlyLabel: 'Show results panel only' });
  refreshResults();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
