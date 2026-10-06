/**
 * "Current Pipeline" panel. A connected workflow is shown as one selectable route of Run prompt and
 * Process data steps; Datasets are not shown. Where several Runs or Processes could come next, that
 * chip becomes a picker and the remainder of the row follows the choice. Branches are drawn only
 * for a Process's named outputs and for the Datasets one Process merges.
 *
 * What runs is chosen here. A card shows its latest run through its Run Pipeline / Stop / Resume
 * buttons; its Run History window lists that pipeline's runs. Output tables are
 * read on the canvas, where a finished run adds them.
 */
import { showAlert } from './alertModal.js';
import { exportPythonPipeline } from './pipelineExportClient.js';
import { buildSelectedRoute, exportRoutePayload, getVisibleRoute } from './pipelineRouteSelection.js';
import { buildPipelineCompileRequest, pipelineInputHasAssets } from './pipelineRunDefinition.js';
import { datasetProducerConflicts } from './pipelineProducerConflicts.js';
import { openPipelineRunDialog } from './pipelineRunDialog.js';
import { pipelineInputSteps } from './pipelineRunInputs.js';
import {
  cancelPipelineRun,
  compileCurrentPipeline,
  getPipelineResults,
  getPipelineRun,
  getPipelineRunDefinition,
  listPipelineRuns,
  newPipelineRequestId,
  resumePipelineRun,
  startCurrentPipeline,
} from './pipelineRunClient.js';

const STEP_LABELS = { prompt: 'Run prompt', process: 'Process data' };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderPickerOrName(choiceId, options, selectedValue, title) {
  if (options.length === 1) return `<span class="pipeline-step-name">${escapeHtml(options[0].label)}</span>`;
  const renderOption = (option) => `<option value="${escapeHtml(option.value)}"${option.value === selectedValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`;
  const kinds = [...new Set(options.map((option) => option.kind))];
  const optionsHtml = kinds.length > 1
    ? kinds.map((kind) => `<optgroup label="${escapeHtml(STEP_LABELS[kind] || kind)}">${options.filter((option) => option.kind === kind).map(renderOption).join('')}</optgroup>`).join('')
    : options.map(renderOption).join('');
  return `<select class="pipeline-step-version-select" data-choice-id="${escapeHtml(choiceId)}" title="${escapeHtml(title)}">${optionsHtml}</select>`;
}

/** The canvas nodes a step stands for: a Run prompt is its Prompt, Run and input Dataset; Process data is its Process and input Datasets. */
function getCanvasNodeIds(step) {
  if (step?.kind === 'branch') {
    return (step.lanes || []).flatMap((lane) => lane.flatMap((laneStep) => getCanvasNodeIds(laneStep)));
  }
  const selected = step.selectedOption;
  if (selected?.dataset?.datasetNodeId) return [selected.dataset.datasetNodeId];
  if (selected?.kind === 'prompt') {
    return [selected.promptNodeId, selected.runNodeId, selected.inputDatasetNodeId].filter(Boolean);
  }
  if (selected?.kind === 'process' && selected.processNodeId) {
    return [selected.processNodeId, ...(selected.inputDatasets || []).map((input) => input.datasetNodeId)].filter(Boolean);
  }
  return [];
}

function renderBranchLanes(step) {
  return (step.lanes || []).map((lane, laneIndex) => `
      <div class="pipeline-overview-branch-lane">
        <span class="pipeline-overview-branch-index">BRANCH ${laneIndex + 1}</span>
        ${lane.map(renderRouteChip).join('<span class="pipeline-overview-branch-arrow" aria-hidden="true">→</span>')}
      </div>
    `).join('');
}

function renderRouteChip(step) {
  if (step.kind === 'empty') {
    return '<span class="pipeline-overview-branch-chip pipeline-overview-branch-chip--empty"><span class="pipeline-step-empty">Do nothing</span></span>';
  }
  // A Process with named outputs inside a branch forks it again.
  if (step.kind === 'branch') {
    return `<div class="pipeline-overview-branch pipeline-overview-branch--nested"><div class="pipeline-overview-branch-lanes">${renderBranchLanes(step)}</div></div>`;
  }
  const picker = renderPickerOrName(
    step.choiceId,
    step.options,
    step.selectedValue,
    step.kind === 'prompt' ? 'Preview one concrete Prompt Run in this branch.' : 'Preview this Process path.',
  );
  const canvasNodeIds = encodeURIComponent(JSON.stringify(getCanvasNodeIds(step)));
  return `<span class="pipeline-overview-branch-chip" tabindex="0" title="Locate on canvas" data-canvas-node-ids="${canvasNodeIds}"><span class="pipeline-step-kind pipeline-step-kind--${step.kind}">${STEP_LABELS[step.kind]}</span>${picker}</span>`;
}

function renderRouteStep(step) {
  if (step.kind === 'branch') {
    return `
      <li class="pipeline-overview-branch">
        <div class="pipeline-overview-branch-lanes">${renderBranchLanes(step)}</div>
      </li>
    `;
  }
  const titles = {
    prompt: 'Preview one concrete Prompt Run and follow its connected output.',
    process: 'Preview one Process path.',
  };
  const picker = renderPickerOrName(
    step.choiceId,
    step.options,
    step.selectedValue,
    titles[step.kind],
  );
  const canvasNodeIds = encodeURIComponent(JSON.stringify(getCanvasNodeIds(step)));
  return `
    <li class="pipeline-overview-step" tabindex="0" title="Locate on canvas" data-canvas-node-ids="${canvasNodeIds}">
      <span class="pipeline-step-kind pipeline-step-kind--${step.kind}">${STEP_LABELS[step.kind]}</span>
      ${picker}
    </li>
  `;
}

function getPipelineViewId(pipeline, index) {
  return String(pipeline?.id || `pipeline-index-${index}`);
}

const ACTIVE_RUN_STATES = new Set(['pending', 'running', 'cancelling']);
const RESUMABLE_RUN_STATES = new Set(['failed', 'cancelled', 'interrupted']);
const PUBLISHABLE_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** Note shown on a Dataset saved from a Pipeline run: when it ran (as Run History lists it)
 * and, when known, the step that made the table. */
export function pipelineResultNote(run, sourceLabel = '') {
  const at = run?.finished_at || run?.created_at;
  const when = at ? ` on ${new Date(at).toLocaleString()}` : '';
  return `Saved from Pipeline run${when}.${sourceLabel ? `\nOutput of ${sourceLabel}.` : ''}`;
}

/** Run and Process node ids in a detected pipeline, to file runs under it. */
function pipelineStepNodeIds(pipeline) {
  const ids = new Set();
  for (const step of pipeline?.steps || []) {
    if (step.kind === 'process') ids.add(step.processNodeId);
    for (const version of step.versions || []) for (const id of version.runNodeIds || []) ids.add(id);
  }
  return ids;
}

/** Canvas node ids of a run's jobs, whose ids are `llm:<Run node>` and `process:<Process node>`. */
function runStepNodeIds(item) {
  return (item?.job_ids || []).map((id) => String(id || '').replace(/^(llm|process):/, ''));
}

function renderRunActions(entry, pipelineIndex) {
  const status = entry?.run?.status;
  const busy = !!entry?.busy;
  if (ACTIVE_RUN_STATES.has(status)) {
    const label = status === 'cancelling' ? 'Stopping…' : 'Running, click to stop';
    return `<button type="button" class="btn btn-secondary pipeline-run-action pipeline-run-action--running" data-action="stop" data-pipeline-index="${pipelineIndex}"${busy || status === 'cancelling' ? ' disabled' : ''}>${label}</button>`;
  }
  const resume = RESUMABLE_RUN_STATES.has(status)
    ? `<button type="button" class="btn btn-secondary pipeline-run-action" data-action="resume" data-pipeline-index="${pipelineIndex}"${busy ? ' disabled' : ''}>Resume</button>`
    : '';
  return `${resume}<button type="button" class="btn btn-secondary pipeline-run-action" data-action="run" data-pipeline-index="${pipelineIndex}"${busy ? ' disabled' : ''}>${busy ? 'Preparing…' : 'Run Pipeline'}</button>`;
}

function renderPipeline(pipeline, index, selectedByChoiceId, entry) {
  const route = buildSelectedRoute(pipeline, selectedByChoiceId);
  const visibleRoute = getVisibleRoute(route);
  const steps = visibleRoute.reduce((html, step, routeIndex) => {
    // Keep the route connectors on both sides of a branch block. The block itself takes a full
    // row, so flex wrapping never bends a connector through its interior.
    const needsArrow = routeIndex > 0;
    const arrow = needsArrow ? '<li class="pipeline-overview-arrow" aria-hidden="true">&#8594;</li>' : '';
    return html + arrow + renderRouteStep(step);
  }, '');
  return `
    <div class="pipeline-overview-card" data-pipeline-index="${index}" data-pipeline-id="${escapeHtml(getPipelineViewId(pipeline, index))}">
      <div class="pipeline-overview-card-header">
        <h3 class="pipeline-overview-card-title">Pipeline ${index + 1}</h3>
        <div class="pipeline-overview-card-actions">
          ${renderRunActions(entry, index)}
          <button type="button" class="btn btn-secondary pipeline-run-history" data-pipeline-index="${index}">Run History</button>
          <button type="button" class="btn btn-secondary pipeline-overview-export" data-pipeline-index="${index}">Export Python Project</button>
        </div>
      </div>
      <ol class="pipeline-overview-steps">${steps}</ol>
    </div>
  `;
}

/**
 * @param {Function|Array} pipelineSource a getter for live data, or a static array for callers
 * @param {{getCanvasState?: Function, getPipelineProjectId?: Function, getAssetProjectId?: Function,
 * highlightCanvasNodes?: Function, openCanvasNode?: Function}} options live canvas hooks;
 * `openCanvasNode` opens a node's window
 */
export function showPipelineOverviewModal(pipelineSource, options = {}) {
  const host = options.host || null;
  const existing = (host || document).querySelector('.pipeline-overview-overlay');
  if (existing) {
    existing.refreshPipelineOverview?.(pipelineSource);
    existing.setPipelineOverviewOptions?.(options);
    if (!host) existing.querySelector('.modal-close')?.focus();
    return;
  }

  let readPipelines = typeof pipelineSource === 'function' ? pipelineSource : () => pipelineSource;
  let getCanvasState = typeof options.getCanvasState === 'function' ? options.getCanvasState : null;
  let highlightCanvasNodes = typeof options.highlightCanvasNodes === 'function'
    ? options.highlightCanvasNodes
    : () => {};
  let focusCanvasNodes = options.focusCanvasNodes || (() => {});
  let getPipelineProjectId = typeof options.getPipelineProjectId === 'function'
    ? options.getPipelineProjectId : async () => { throw new Error('No project is open.'); };
  let getAssetProjectId = typeof options.getAssetProjectId === 'function'
    ? options.getAssetProjectId : () => null;
  let publishPipelineRun = typeof options.publishPipelineRun === 'function'
    ? options.publishPipelineRun : null;
  let openCanvasNode = typeof options.openCanvasNode === 'function' ? options.openCanvasNode : () => {};
  let pipelines = [];
  let pipelineSignature = '';
  let canvasWarnings = '';
  let canvasNodes = [];
  let refreshFrame = 0;
  let pollTimer = 0;
  let attachedProjectId = '';
  let destroyed = false;
  const runEntriesByPipelineId = new Map();
  const publishingRunIds = new Set();
  const publicationErrors = new Map();
  let runHistory = [];

  const overlay = document.createElement('div');
  overlay.className = host ? 'workspace-dock pipeline-overview-overlay' : 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('role', host ? 'region' : 'dialog');
  // Docked, the bottom panel's tab names this view and owns collapse/full-screen, so no header.
  if (host) overlay.setAttribute('aria-label', 'Current Pipeline');
  else overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  const selectedByChoiceId = new Map();
  // Agent reads the same picker state as the panel instead of rebuilding a default route.
  overlay.getPipelineSelections = () => (readPipelines?.() || []).map((pipeline, index) => ({
    id: getPipelineViewId(pipeline, index),
    index,
    route: buildSelectedRoute(pipeline, selectedByChoiceId),
    nodeIds: [...pipelineStepNodeIds(pipeline)],
  }));
  overlay.getPipelineRunNeedsAssets = (runId) => entryForRun(runId)?.needsAssets;
  overlay.registerAgentRun = async (pipelineId, run, needsAssets) => {
    await syncProjectContext();
    if (destroyed || !attachedProjectId || run.project_id !== attachedProjectId) {
      throw new Error('The open project changed while starting this Pipeline.');
    }
    runEntriesByPipelineId.set(pipelineId, { run, needsAssets: needsAssets ?? entryForRun(run.run_id)?.needsAssets ?? false });
    applyRun(run);
    persistRuns();
    ensurePolling();
    renderBody();
  };
  const emptyText = 'No pipelines detected yet — a pipeline needs at least one Prompt with a Run, or a Process.';

  overlay.innerHTML = `
    <div class="modal-panel modal-panel--pipeline-overview">
      ${host ? '' : `<div class="modal-header">
        <h2 id="pipeline-overview-title" class="modal-title">Current Pipeline</h2>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>`}
      <div class="modal-body pipeline-overview-body"></div>
    </div>
  `;

  const bodyEl = overlay.querySelector('.pipeline-overview-body');
  // Run History: one pipeline's runs, opened from its card, as a modal over the rest of the app.
  const runsWindow = document.createElement('div');
  runsWindow.className = 'modal-overlay pipeline-runs-overlay';
  runsWindow.hidden = true;
  runsWindow.innerHTML = `
    <div class="modal-panel modal-panel--pipeline-runs" role="dialog" aria-modal="true" aria-labelledby="pipeline-runs-title">
      <div class="modal-header">
        <h2 id="pipeline-runs-title" class="modal-title"></h2>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body pipeline-overview-body"></div>
    </div>`;
  const runsTitleEl = runsWindow.querySelector('.modal-title');
  const runsEl = runsWindow.querySelector('.pipeline-overview-body');
  document.body.appendChild(runsWindow);
  let historyPipelineId = '';

  function clearCanvasHighlight() {
    highlightCanvasNodes([]);
  }
  function storageKey(projectId) {
    return `annobio.pipeline-runs.v1:${projectId}`;
  }
  function publishedKey(projectId, runId) {
    return `annobio.pipeline-published.v1:${projectId}:${runId}`;
  }
  function producedIds(run) {
    return (run?.artifacts || []).filter((item) => item.valid && item.producer).map((item) => item.logical_id);
  }
  function wasPublished(runId, producedArtifactIds = [], knownCanvasNodes = null) {
    // A run that produced nothing has nothing on the canvas.
    if (!producedArtifactIds?.length) return false;
    try {
      if (localStorage.getItem(publishedKey(attachedProjectId, runId)) !== '1') return false;
      const nodes = knownCanvasNodes || canvasNodes;
      return producedArtifactIds.every((logicalId) => nodes.some((node) => (
        node.pipelineRunId === runId && node.pipelineLogicalId === logicalId
      )));
    }
    catch (_) { return false; }
  }
  /** Runs live outside the project file, so results missing from the canvas after they were added
   * once were removed by the user (deleted, or an older save restored), and are not added again. */
  function everPublished(runId) {
    try { return localStorage.getItem(publishedKey(attachedProjectId, runId)) === '1'; }
    catch (_) { return false; }
  }
  function storedRuns(projectId) {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey(projectId)) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }
  function persistRuns() {
    if (!attachedProjectId) return;
    const records = Array.from(runEntriesByPipelineId.entries())
      .filter(([, entry]) => entry?.run?.run_id)
      .map(([pipelineId, entry]) => ({
        pipeline_id: pipelineId,
        run_id: entry.run.run_id,
        needs_assets: entry.needsAssets === true,
      }));
    try { localStorage.setItem(storageKey(attachedProjectId), JSON.stringify(records)); } catch (_) {}
  }
  function entryForRun(runId) {
    return [...runEntriesByPipelineId.values()].find((entry) => entry?.run?.run_id === runId) || null;
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }
  function rememberRun(run) {
    if (!run?.run_id) return;
    const previous = runHistory.find((item) => item.run_id === run.run_id);
    const summary = {
      ...(previous || {}), run_id: run.run_id, status: run.status,
      created_at: run.created_at || previous?.created_at,
      finished_at: run.finished_at || previous?.finished_at,
      error: run.error ?? previous?.error,
      job_count: run.jobs?.length ?? previous?.job_count,
      job_ids: Array.isArray(run.jobs) ? run.jobs.map((job) => job.job_id) : previous?.job_ids || [],
      succeeded_job_count: Array.isArray(run.jobs)
        ? run.jobs.filter((job) => job.status === 'succeeded').length : previous?.succeeded_job_count,
      produced_artifact_ids: Array.isArray(run.artifacts) ? producedIds(run) : previous?.produced_artifact_ids || [],
    };
    runHistory = [summary, ...runHistory.filter((item) => item.run_id !== run.run_id)]
      .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
  }
  /** Keeps every view of a run (Run History and the card) on its latest status. */
  function applyRun(run) {
    rememberRun(run);
    const entry = entryForRun(run.run_id);
    if (entry) entry.run = run;
  }
  async function publishCompletedRun(run) {
    const produced = producedIds(run);
    if (!publishPipelineRun || !PUBLISHABLE_RUN_STATES.has(run?.status) || !run?.run_id || !produced.length
      || wasPublished(run.run_id, produced)
      || everPublished(run.run_id)
      || publishingRunIds.has(run.run_id)) return;
    const projectId = attachedProjectId;
    publishingRunIds.add(run.run_id);
    try {
      const definition = await getPipelineRunDefinition(projectId, run.run_id);
      if (destroyed || attachedProjectId !== projectId) return;
      const result = await publishPipelineRun({
        run, definition,
        getArtifact: async (logicalId) => {
          const response = await getPipelineResults(projectId, run.run_id, logicalId);
          return response.outputs?.[0] || null;
        },
      });
      if (result?.historyError) throw new Error(result.historyError);
      canvasNodes = getCanvasState?.()?.nodes || canvasNodes;
      try { localStorage.setItem(publishedKey(projectId, run.run_id), '1'); } catch (_) {}
      publicationErrors.delete(run.run_id);
      renderBody();
    } catch (error) {
      const message = `Canvas sync failed: ${error?.message || error}`;
      publicationErrors.set(run.run_id, message);
      if (!destroyed) renderBody();
    } finally {
      publishingRunIds.delete(run.run_id);
    }
  }
  /** Fetches a run's status. With `publish`, a finished run is added to the canvas (once, see everPublished);
   * merely looking at an older run in Run History never adds it. */
  async function refreshRun(runId, { publish = false } = {}) {
    const projectId = attachedProjectId;
    const run = await getPipelineRun(projectId, runId);
    if (destroyed || projectId !== attachedProjectId) return null;
    applyRun(run);
    if (publish && PUBLISHABLE_RUN_STATES.has(run.status)) await publishCompletedRun(run);
    return run;
  }
  function activeRunIds() {
    const ids = new Set(runHistory.filter((item) => ACTIVE_RUN_STATES.has(item.status)).map((item) => item.run_id));
    for (const entry of runEntriesByPipelineId.values()) {
      if (ACTIVE_RUN_STATES.has(entry?.run?.status)) ids.add(entry.run.run_id);
    }
    return ids;
  }
  async function pollRuns() {
    const ids = activeRunIds();
    if (!ids.size) {
      stopPolling();
      return;
    }
    await Promise.all([...ids].map((runId) => refreshRun(runId, { publish: true }).catch((error) => {
      // Removed outside the app: stop asking about it.
      if (/not found/i.test(error?.message || '')) runHistory = runHistory.filter((item) => item.run_id !== runId);
    })));
    persistRuns();
    if (!destroyed) renderBody();
  }
  function ensurePolling() {
    if (pollTimer || !activeRunIds().size) return;
    pollTimer = setInterval(() => pollRuns().catch(() => {}), 800);
  }
  async function syncProjectContext() {
    let projectId;
    try { projectId = await getPipelineProjectId(); } catch (_) { projectId = ''; }
    if (destroyed || projectId === attachedProjectId) return;
    stopPolling();
    attachedProjectId = projectId;
    runEntriesByPipelineId.clear();
    publicationErrors.clear();
    runHistory = [];
    if (!projectId) {
      renderBody();
      return;
    }
    for (const record of storedRuns(projectId)) {
      if (!record?.pipeline_id || !record?.run_id) continue;
      runEntriesByPipelineId.set(record.pipeline_id, {
        run: { run_id: record.run_id, status: 'pending' },
        needsAssets: record.needs_assets === true,
      });
    }
    runHistory = await listPipelineRuns(projectId).catch(() => []);
    if (destroyed || projectId !== attachedProjectId) return;
    await Promise.all(Array.from(runEntriesByPipelineId.entries()).map(async ([pipelineId, entry]) => {
      try { await refreshRun(entry.run.run_id, { publish: true }); }
      catch (_) { runEntriesByPipelineId.delete(pipelineId); }
    }));
    persistRuns();
    const latestUnpublished = runHistory.find((item) => PUBLISHABLE_RUN_STATES.has(item.status)
      && item.produced_artifact_ids?.length
      && !everPublished(item.run_id));
    if (latestUnpublished) await refreshRun(latestUnpublished.run_id, { publish: true }).catch(() => null);
    ensurePolling();
    if (!destroyed) renderBody();
  }
  function highlightRouteStep(stepEl) {
    if (!stepEl) {
      clearCanvasHighlight();
      return;
    }
    try {
      const encodedIds = stepEl.dataset.canvasNodeIds || '';
      const ids = JSON.parse(decodeURIComponent(encodedIds));
      highlightCanvasNodes(Array.isArray(ids) ? ids : []);
    } catch (_) {
      clearCanvasHighlight();
    }
  }
  /** The runs of one pipeline: each run is filed under the pipeline holding most of its steps. */
  function runsOfPipeline(pipelineIndex) {
    const nodeIdSets = pipelines.map((pipeline) => pipelineStepNodeIds(pipeline));
    return runHistory.filter((item) => {
      const ids = runStepNodeIds(item);
      let best = -1;
      let bestCount = 0;
      nodeIdSets.forEach((nodeIds, index) => {
        const count = ids.filter((id) => nodeIds.has(id)).length;
        if (count > bestCount) { best = index; bestCount = count; }
      });
      return best === pipelineIndex;
    });
  }
  function renderRunRow(item) {
    const status = item.status || 'pending';
    const problem = [item.error, publicationErrors.get(item.run_id)].filter(Boolean).join('\n');
    return `<tr data-run-id="${escapeHtml(item.run_id)}">
      <td${problem ? ` title="${escapeHtml(problem)}"` : ''}><span class="pipeline-run-status pipeline-run-status--${escapeHtml(status)}">${escapeHtml(status)}</span></td>
      <td>${escapeHtml(item.created_at ? new Date(item.created_at).toLocaleString() : '')}</td>
      <td class="pipeline-runs-muted"><code>${escapeHtml(item.run_id.slice(0, 8))}</code></td>
    </tr>`;
  }
  function renderRunsWindow() {
    const pipelineIndex = historyPipelineId
      ? pipelines.findIndex((pipeline, index) => getPipelineViewId(pipeline, index) === historyPipelineId)
      : -1;
    if (pipelineIndex < 0 || !attachedProjectId) {
      historyPipelineId = '';
      runsWindow.hidden = true;
      return;
    }
    runsWindow.hidden = false;
    runsTitleEl.textContent = `Pipeline ${pipelineIndex + 1} · Run History`;
    const runs = runsOfPipeline(pipelineIndex);
    runsEl.innerHTML = runs.length
      ? `<div class="pipeline-runs"><table class="pipeline-runs-table">
          <colgroup><col style="width: 20%"><col style="width: 40%"><col></colgroup>
          <thead><tr><th>Status</th><th>Started</th><th>Run ID</th></tr></thead>
          <tbody>${runs.map(renderRunRow).join('')}</tbody>
        </table></div>`
      : '<p class="pipeline-overview-empty">No runs yet. Click Run Pipeline to start one.</p>';
  }
  function openRunHistory(pipelineId) {
    historyPipelineId = pipelineId;
    renderRunsWindow();
    if (!runsWindow.hidden) runsWindow.querySelector('.modal-close')?.focus();
  }
  function closeRunHistory() {
    historyPipelineId = '';
    runsWindow.hidden = true;
    clearCanvasHighlight();
  }
  function renderBody() {
    clearCanvasHighlight();
    const content = pipelines.length > 0
      ? pipelines.map((pipeline, index) => {
        const pipelineId = getPipelineViewId(pipeline, index);
        return renderPipeline(pipeline, index, selectedByChoiceId, runEntriesByPipelineId.get(pipelineId));
      }).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
    bodyEl.innerHTML = canvasWarnings + content;
    renderRunsWindow();
  }
  function refresh(nextSource) {
    if (typeof nextSource === 'function') readPipelines = nextSource;
    const nextPipelines = readPipelines?.() || [];
    const state = getCanvasState?.();
    canvasNodes = state?.nodes || [];
    const names = new Map((state?.nodes || []).map((node) => [node.nodeId, node.name || node.nodeId]));
    const conflicts = datasetProducerConflicts(state);
    const conflictNotice = conflicts.length
      ? `<div class="pipeline-run-validation pipeline-run-validation--error">Dataset source conflict: ${escapeHtml(conflicts.map((item) => names.get(item.datasetId) || item.datasetId).join(', '))}. Remove the extra producer link before running or exporting.</div>`
      : '';
    // Saved copies whose source has moved on are shown on the canvas as dashed edges, not listed here.
    const nextWarnings = conflictNotice;
    const nextSignature = JSON.stringify({ pipelines: nextPipelines, warnings: nextWarnings });
    if (nextSignature !== pipelineSignature) {
      pipelines = nextPipelines;
      canvasWarnings = nextWarnings;
      pipelineSignature = nextSignature;
      renderBody();
    }
    syncProjectContext().catch(() => {});
  }
  function scheduleRefresh() {
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      refresh();
    });
  }
  overlay.refreshPipelineOverview = refresh;
  overlay.setPipelineOverviewOptions = (nextOptions = {}) => {
    if (typeof nextOptions.getCanvasState === 'function') getCanvasState = nextOptions.getCanvasState;
    if (typeof nextOptions.highlightCanvasNodes === 'function') {
      highlightCanvasNodes = nextOptions.highlightCanvasNodes;
    }
    if (typeof nextOptions.focusCanvasNodes === 'function') focusCanvasNodes = nextOptions.focusCanvasNodes;
    if (typeof nextOptions.getPipelineProjectId === 'function') getPipelineProjectId = nextOptions.getPipelineProjectId;
    if (typeof nextOptions.getAssetProjectId === 'function') getAssetProjectId = nextOptions.getAssetProjectId;
    if (typeof nextOptions.publishPipelineRun === 'function') publishPipelineRun = nextOptions.publishPipelineRun;
    if (typeof nextOptions.openCanvasNode === 'function') openCanvasNode = nextOptions.openCanvasNode;
    syncProjectContext().catch(() => {});
  };
  refresh();

  bodyEl.addEventListener('change', (event) => {
    const select = event.target.closest?.('.pipeline-step-version-select');
    if (!select) return;
    selectedByChoiceId.set(select.getAttribute('data-choice-id'), select.value);
    renderBody();
  });

  bodyEl.addEventListener('pointerover', (event) => {
    const stepEl = event.target.closest?.('.pipeline-overview-step, .pipeline-overview-branch-chip');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    highlightRouteStep(stepEl);
  });
  bodyEl.addEventListener('pointerout', (event) => {
    const stepEl = event.target.closest?.('.pipeline-overview-step, .pipeline-overview-branch-chip');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    clearCanvasHighlight();
  });
  bodyEl.addEventListener('focusin', (event) => {
    highlightRouteStep(event.target.closest?.('.pipeline-overview-step, .pipeline-overview-branch-chip'));
  });
  bodyEl.addEventListener('focusout', (event) => {
    const stepEl = event.target.closest?.('.pipeline-overview-step, .pipeline-overview-branch-chip');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    clearCanvasHighlight();
  });

  function selectedPipelineContext(button) {
    const card = button.closest('.pipeline-overview-card');
    const pipelineIndex = Number.parseInt(card?.dataset.pipelineIndex || '-1', 10);
    const pipelineId = card?.dataset.pipelineId || '';
    const pipeline = pipelineIndex >= 0 ? pipelines[pipelineIndex] : null;
    const route = pipeline ? exportRoutePayload(buildSelectedRoute(pipeline, selectedByChoiceId)) : null;
    return { card, pipelineIndex, pipelineId, pipeline, route };
  }

  async function onPanelClick(event) {
    if (!event.target.closest('select, button, input, label')) {
      const step = event.target.closest('[data-canvas-node-ids]');
      if (step) focusCanvasNodes(JSON.parse(decodeURIComponent(step.dataset.canvasNodeIds)));
    }
    const historyButton = event.target.closest?.('.pipeline-run-history');
    if (historyButton) {
      openRunHistory(historyButton.closest('.pipeline-overview-card')?.dataset.pipelineId || '');
      return;
    }
    const actionButton = event.target.closest?.('.pipeline-run-action');
    if (actionButton && !actionButton.disabled) {
      const context = selectedPipelineContext(actionButton);
      let entry = runEntriesByPipelineId.get(context.pipelineId);
      if (!entry && actionButton.dataset.action === 'run') {
        entry = { run: null };
        runEntriesByPipelineId.set(context.pipelineId, entry);
      }
      actionButton.disabled = true;
      try {
        if (actionButton.dataset.action === 'run') {
          if (!context.pipeline || !getCanvasState || !attachedProjectId) throw new Error('Open a project and select a Pipeline first.');
          entry.busy = true;
          renderBody();
          const projectId = attachedProjectId;
          // Steps opened from Run Pipeline can change the canvas, so the route is read again each time.
          const currentRoute = () => {
            const pipeline = (readPipelines?.() || []).find((item, index) => getPipelineViewId(item, index) === context.pipelineId)
              || context.pipeline;
            return exportRoutePayload(buildSelectedRoute(pipeline, selectedByChoiceId));
          };
          // The Current Pipeline shows only the route. Run Pipeline shows what each step reads, opens
          // the step to change it, and says only what keeps the run from starting.
          const confirmed = await openPipelineRunDialog({
            getSteps: () => pipelineInputSteps(getCanvasState(), currentRoute()),
            openNode: (nodeId) => openCanvasNode(nodeId),
            check: async () => {
              const compiled = await compileCurrentPipeline({ canvasState: getCanvasState(), route: currentRoute() });
              if (compiled.spec) return [];
              const errors = (compiled.diagnostics || []).filter((item) => item.severity === 'error')
                .map((item) => ({ nodeId: item.node_id, nodeName: item.node_name, message: item.message }));
              return errors.length ? errors : [{ message: 'This Pipeline cannot run.' }];
            },
          });
          if (!confirmed || destroyed || projectId !== attachedProjectId || !runEntriesByPipelineId.has(context.pipelineId)) {
            entry.busy = false;
            renderBody();
            return;
          }
          const canvasState = getCanvasState();
          const route = currentRoute();
          const signature = JSON.stringify(buildPipelineCompileRequest({ canvasState, route }));
          if (entry.requestSignature !== signature) {
            entry.requestId = newPipelineRequestId();
            entry.requestSignature = signature;
          }
          entry.run = await startCurrentPipeline({
            projectId, assetProjectId: getAssetProjectId(),
            canvasState, route, requestId: entry.requestId,
          });
          // Autosave writes the file's run owner (currentProject.js), so the run stays listed after reopening.
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
          applyRun(entry.run);
          entry.needsAssets = pipelineInputHasAssets(canvasState, route);
          entry.busy = false;
          entry.requestId = null;
          entry.requestSignature = null;
          persistRuns();
          ensurePolling();
          renderBody();
        } else if (actionButton.dataset.action === 'stop' && entry?.run?.run_id) {
          entry.busy = true;
          applyRun(await cancelPipelineRun(attachedProjectId, entry.run.run_id));
          entry.busy = false;
          ensurePolling();
          renderBody();
        } else if (actionButton.dataset.action === 'resume' && entry?.run?.run_id) {
          entry.busy = true;
          renderBody();
          applyRun(await resumePipelineRun(
            attachedProjectId, entry.run.run_id, getAssetProjectId(), entry.needsAssets,
          ));
          entry.busy = false;
          persistRuns();
          ensurePolling();
          renderBody();
        }
      } catch (error) {
        if (entry) entry.busy = false;
        renderBody();
        showAlert(error instanceof Error ? error.message : 'Pipeline action failed.', { title: 'Pipeline' });
      }
      return;
    }

    const button = event.target.closest?.('.pipeline-overview-export');
    if (!button || button.disabled) return;
    const pipelineIndex = Number.parseInt(button.getAttribute('data-pipeline-index') || '', 10);
    const pipeline = pipelines[pipelineIndex];
    if (!pipeline || !getCanvasState) {
      showAlert('The live canvas is unavailable for export.', { title: 'Cannot export Pipeline' });
      return;
    }
    const route = buildSelectedRoute(pipeline, selectedByChoiceId);
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Exporting…';
    try {
      const promptName = route.find((step) => step.selectedOption?.kind === 'prompt')
        ?.selectedOption?.promptName;
      const processName = route.find((step) => step.selectedOption?.kind === 'process')
        ?.selectedOption?.label;
      const stepName = promptName || processName;
      await exportPythonPipeline({
        name: stepName ? `${stepName} pipeline` : `pipeline-${pipelineIndex + 1}`,
        canvasState: getCanvasState(),
        route: exportRoutePayload(route),
      });
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Could not export this Pipeline.', {
        title: 'Cannot export Pipeline',
      });
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  }
  bodyEl.addEventListener('click', onPanelClick);

  runsWindow.querySelector('.modal-close').addEventListener('click', closeRunHistory);
  runsWindow.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeRunHistory();
  });

  bodyEl.addEventListener('keydown', (event) => {
    if (!event.target.matches('[data-canvas-node-ids]') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    focusCanvasNodes(JSON.parse(decodeURIComponent(event.target.dataset.canvasNodeIds)));
  });

  function destroy() {
    destroyed = true;
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    stopPolling();
    clearCanvasHighlight();
    overlay.remove();
    runsWindow.remove();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('workflow:canvas-changed', scheduleRefresh);
    document.removeEventListener('workflow:history-resolved', scheduleRefresh);
    document.removeEventListener('workflow:project-changed', onProjectChanged);
  }
  overlay.destroyPipelineOverview = destroy;
  function onKeyDown(event) {
    if (event.key === 'Escape') destroy();
  }
  overlay.querySelector('.modal-close')?.addEventListener('click', destroy);
  if (!host) document.addEventListener('keydown', onKeyDown);
  document.addEventListener('workflow:canvas-changed', scheduleRefresh);
  document.addEventListener('workflow:history-resolved', scheduleRefresh);
  function onProjectChanged() {
    syncProjectContext().catch(() => {});
  }
  document.addEventListener('workflow:project-changed', onProjectChanged);

  (host || document.body).appendChild(overlay);
}
