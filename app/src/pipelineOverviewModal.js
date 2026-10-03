/**
 * "Current Pipeline" panel. A connected workflow is shown as one selectable route of Run prompt and
 * Process data steps; Datasets are not shown. Where several Runs or Processes could come next, that
 * chip becomes a picker and the remainder of the row follows the choice. Branches are drawn only
 * for a Process's named outputs and for the Datasets one Process merges.
 */
import { showAlert } from './alertModal.js';
import { exportPythonPipeline } from './pipelineExportClient.js';
import { buildSelectedRoute, exportRoutePayload, getVisibleRoute } from './pipelineRouteSelection.js';
import {
  cancelPipelineRun,
  getPipelineResults,
  getPipelineRun,
  resumePipelineRun,
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

function displayValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
}

function renderArtifactPreview(entry) {
  const preview = entry?.preview;
  if (!preview?.table) return '';
  const headers = preview.table.headers || [];
  const rows = preview.table.rows || [];
  const visibleHeaders = headers.slice(0, 12);
  const body = rows.slice(0, 20).map((row) => `<tr>${visibleHeaders.map((_, index) => `<td>${escapeHtml(displayValue(row?.[index]))}</td>`).join('')}</tr>`).join('');
  const omitted = headers.length > visibleHeaders.length || rows.length > 20;
  return `
    <div class="pipeline-artifact-preview">
      <div class="pipeline-artifact-preview-header">
        <strong>${escapeHtml(preview.artifact?.name || preview.logical_id || 'Artifact')}</strong>
        <span>${rows.length} row${rows.length === 1 ? '' : 's'}${preview.artifact?.valid === false ? ' · partial' : ''}</span>
        <button type="button" class="btn btn-secondary pipeline-save-artifact" data-logical-id="${escapeHtml(preview.logical_id || '')}">Save as Dataset</button>
      </div>
      <div class="pipeline-artifact-table-wrap"><table class="pipeline-artifact-table">
        <thead><tr>${visibleHeaders.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${body || `<tr><td colspan="${Math.max(1, visibleHeaders.length)}">Empty artifact</td></tr>`}</tbody>
      </table></div>
      ${omitted ? '<div class="pipeline-artifact-preview-note">Preview shows the first 20 rows and 12 columns.</div>' : ''}
    </div>`;
}

function renderRunState(entry) {
  const run = entry?.run;
  if (!run) return '';
  const jobs = new Map((run.jobs || []).map((job) => [job.job_id, job]));
  const plan = run.plan || {};
  const inputs = (plan.inputs || []).map((input) => `${input.name}: ${input.row_count} row${input.row_count === 1 ? '' : 's'}`).join(' · ');
  const planJobs = (plan.jobs || []).map((job) => {
    const state = jobs.get(job.job_id) || {};
    const progress = state.total == null ? '' : ` · ${state.completed || 0}/${state.total}`;
    const model = job.model?.model ? ` · ${job.model.model}` : '';
    const calls = job.type === 'llm'
      ? ` · calls ${job.estimated_calls == null ? 'unknown (dynamic upstream)' : job.estimated_calls}`
      : '';
    const reused = state.reused_from ? ' · reused checkpoint' : '';
    return `<li><span class="pipeline-job-status pipeline-job-status--${escapeHtml(state.status || 'pending')}">${escapeHtml(state.status || 'pending')}</span><strong>${escapeHtml(job.name || job.job_id)}</strong><span>${escapeHtml(model + calls + progress + reused)}</span>${state.error ? `<div class="pipeline-job-error">${escapeHtml(state.error)}</div>` : ''}</li>`;
  }).join('');
  const artifacts = (run.artifacts || []).map((artifact) => `
    <button type="button" class="pipeline-artifact-chip${artifact.valid === false ? ' pipeline-artifact-chip--partial' : ''}" data-logical-id="${escapeHtml(artifact.logical_id)}">
      ${escapeHtml(artifact.name || artifact.logical_id)} <span>${artifact.row_count}</span>
    </button>`).join('');
  return `
    <div class="pipeline-run-panel">
      <div class="pipeline-run-summary">
        <span class="pipeline-run-status pipeline-run-status--${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
        <span>Revision ${escapeHtml(run.revision || 1)}</span>
        <span>${escapeHtml(inputs || 'No input summary')}</span>
        <code>${escapeHtml(String(run.run_id || '').slice(0, 8))}</code>
      </div>
      ${run.error ? `<div class="pipeline-run-error">${escapeHtml(run.error)}</div>` : ''}
      <ol class="pipeline-job-list">${planJobs}</ol>
      ${artifacts ? `<div class="pipeline-artifact-list"><span>Artifacts</span>${artifacts}</div>` : ''}
      ${renderArtifactPreview(entry)}
    </div>`;
}

function renderRunActions(entry, pipelineIndex) {
  const status = entry?.run?.status;
  const busy = !!entry?.busy;
  if (ACTIVE_RUN_STATES.has(status)) {
    return `<button type="button" class="btn btn-secondary pipeline-run-action" data-action="stop" data-pipeline-index="${pipelineIndex}"${busy ? ' disabled' : ''}>${status === 'cancelling' ? 'Stopping…' : 'Stop'}</button>`;
  }
  const resume = RESUMABLE_RUN_STATES.has(status)
    ? `<button type="button" class="btn btn-secondary pipeline-run-action" data-action="resume" data-pipeline-index="${pipelineIndex}"${busy ? ' disabled' : ''}>Resume</button>`
    : '';
  return resume;
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
          <button type="button" class="btn btn-secondary pipeline-overview-export" data-pipeline-index="${index}">Export Python Project</button>
        </div>
      </div>
      <ol class="pipeline-overview-steps">${steps}</ol>
      ${renderRunState(entry)}
    </div>
  `;
}

function renderDetachedRun(pipelineId, entry) {
  return `<div class="pipeline-overview-card pipeline-overview-card--detached" data-pipeline-index="-1" data-pipeline-id="${escapeHtml(pipelineId)}">
    <div class="pipeline-overview-card-header"><h3 class="pipeline-overview-card-title">Frozen Pipeline snapshot</h3><div class="pipeline-overview-card-actions">${renderRunActions(entry, -1)}</div></div>
    <p class="pipeline-run-detached-note">The canvas route changed or was removed. This run continues with its frozen plan and input snapshot.</p>
    ${renderRunState(entry)}
  </div>`;
}

/**
 * @param {Function|Array} pipelineSource a getter for live data, or a static array for callers
 * @param {{getCanvasState?: Function, getPipelineProjectId?: Function, getAssetProjectId?: Function,
 * saveArtifactAsDataset?: Function, highlightCanvasNodes?: Function}} options live canvas hooks
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
  let saveArtifactAsDataset = typeof options.saveArtifactAsDataset === 'function'
    ? options.saveArtifactAsDataset : null;
  let pipelines = [];
  let pipelineSignature = '';
  let refreshFrame = 0;
  let pollTimer = 0;
  let attachedProjectId = '';
  let destroyed = false;
  const runEntriesByPipelineId = new Map();

  const overlay = document.createElement('div');
  overlay.className = host ? 'workspace-dock pipeline-overview-overlay' : 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('role', host ? 'region' : 'dialog');
  // Docked, the bottom panel's tab names this view and owns collapse/full-screen, so no header.
  if (host) overlay.setAttribute('aria-label', 'Current Pipeline');
  else overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  const selectedByChoiceId = new Map();
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
  function clearCanvasHighlight() {
    highlightCanvasNodes([]);
  }
  function storageKey(projectId) {
    return `annobio.pipeline-runs.v1:${projectId}`;
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
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }
  async function loadDefaultPreview(entry) {
    if (!entry?.run || entry.preview || entry.run.status !== 'succeeded') return;
    const data = await getPipelineResults(attachedProjectId, entry.run.run_id);
    entry.preview = data.outputs?.[0] || null;
  }
  async function updateRunEntry(pipelineId, { render = true } = {}) {
    const entry = runEntriesByPipelineId.get(pipelineId);
    if (!entry?.run?.run_id || !attachedProjectId) return;
    entry.run = await getPipelineRun(attachedProjectId, entry.run.run_id);
    await loadDefaultPreview(entry).catch(() => {});
    if (render && !destroyed) renderBody();
    persistRuns();
  }
  async function pollRuns() {
    const active = Array.from(runEntriesByPipelineId.entries())
      .filter(([, entry]) => ACTIVE_RUN_STATES.has(entry?.run?.status));
    if (!active.length) {
      stopPolling();
      return;
    }
    await Promise.all(active.map(([pipelineId]) => updateRunEntry(pipelineId, { render: false }).catch(() => {})));
    if (!destroyed) renderBody();
  }
  function ensurePolling() {
    if (pollTimer || !Array.from(runEntriesByPipelineId.values()).some((entry) => ACTIVE_RUN_STATES.has(entry?.run?.status))) return;
    pollTimer = setInterval(() => pollRuns().catch(() => {}), 800);
  }
  async function syncProjectContext() {
    let projectId;
    try { projectId = await getPipelineProjectId(); } catch (_) { projectId = ''; }
    if (destroyed || projectId === attachedProjectId) return;
    stopPolling();
    attachedProjectId = projectId;
    runEntriesByPipelineId.clear();
    if (!projectId) {
      renderBody();
      return;
    }
    for (const record of storedRuns(projectId)) {
      if (!record?.pipeline_id || !record?.run_id) continue;
      runEntriesByPipelineId.set(record.pipeline_id, {
        run: { run_id: record.run_id, status: 'pending' },
        needsAssets: record.needs_assets === true,
        preview: null,
      });
    }
    await Promise.all(Array.from(runEntriesByPipelineId.keys()).map(async (pipelineId) => {
      try { await updateRunEntry(pipelineId, { render: false }); }
      catch (_) { runEntriesByPipelineId.delete(pipelineId); }
    }));
    persistRuns();
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
  function renderBody() {
    clearCanvasHighlight();
    const visibleIds = new Set(pipelines.map((pipeline, index) => getPipelineViewId(pipeline, index)));
    const content = pipelines.length > 0
      ? pipelines.map((pipeline, index) => {
        const pipelineId = getPipelineViewId(pipeline, index);
        return renderPipeline(pipeline, index, selectedByChoiceId, runEntriesByPipelineId.get(pipelineId));
      }).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
    const detached = Array.from(runEntriesByPipelineId.entries())
      .filter(([pipelineId]) => !visibleIds.has(pipelineId))
      .map(([pipelineId, entry]) => renderDetachedRun(pipelineId, entry))
      .join('');
    bodyEl.innerHTML = content + detached;
  }
  function refresh(nextSource) {
    if (typeof nextSource === 'function') readPipelines = nextSource;
    const nextPipelines = readPipelines?.() || [];
    const nextSignature = JSON.stringify(nextPipelines);
    if (nextSignature !== pipelineSignature) {
      pipelines = nextPipelines;
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
    if (typeof nextOptions.saveArtifactAsDataset === 'function') saveArtifactAsDataset = nextOptions.saveArtifactAsDataset;
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

  bodyEl.addEventListener('click', async (event) => {
    if (!event.target.closest('select, button, input, label')) {
      const step = event.target.closest('[data-canvas-node-ids]');
      if (step) focusCanvasNodes(JSON.parse(decodeURIComponent(step.dataset.canvasNodeIds)));
    }
    const artifactButton = event.target.closest?.('.pipeline-artifact-chip');
    if (artifactButton && !artifactButton.disabled) {
      const context = selectedPipelineContext(artifactButton);
      const entry = runEntriesByPipelineId.get(context.pipelineId);
      if (!entry?.run?.run_id || !attachedProjectId) return;
      artifactButton.disabled = true;
      try {
        const result = await getPipelineResults(attachedProjectId, entry.run.run_id, artifactButton.dataset.logicalId);
        entry.preview = result.outputs?.[0] || null;
        renderBody();
      } catch (error) {
        showAlert(error instanceof Error ? error.message : 'Could not load this artifact.', { title: 'Cannot load Artifact' });
      }
      return;
    }

    const saveButton = event.target.closest?.('.pipeline-save-artifact');
    if (saveButton && !saveButton.disabled) {
      const context = selectedPipelineContext(saveButton);
      const entry = runEntriesByPipelineId.get(context.pipelineId);
      const preview = entry?.preview;
      if (!preview?.table || !saveArtifactAsDataset) return;
      saveButton.disabled = true;
      try {
        await saveArtifactAsDataset({
          name: preview.artifact?.name || 'Pipeline result',
          notes: `Saved from Pipeline run ${entry.run.run_id}. Logical artifact: ${preview.logical_id}.`,
          headers: preview.table.headers || [],
          rows: preview.table.rows || [],
          columnTypes: preview.table.column_types || [],
          rowIds: preview.table.row_ids || [],
        });
      } catch (error) {
        showAlert(error instanceof Error ? error.message : 'Could not save this artifact.', { title: 'Cannot save Artifact' });
      } finally {
        if (saveButton.isConnected) saveButton.disabled = false;
      }
      return;
    }

    const actionButton = event.target.closest?.('.pipeline-run-action');
    if (actionButton && !actionButton.disabled) {
      const context = selectedPipelineContext(actionButton);
      const entry = runEntriesByPipelineId.get(context.pipelineId);
      actionButton.disabled = true;
      try {
        if (actionButton.dataset.action === 'stop' && entry?.run?.run_id) {
          entry.busy = true;
          entry.run = await cancelPipelineRun(attachedProjectId, entry.run.run_id);
          entry.busy = false;
          ensurePolling();
          renderBody();
        } else if (actionButton.dataset.action === 'resume' && entry?.run?.run_id) {
          entry.busy = true;
          renderBody();
          entry.run = await resumePipelineRun(
            attachedProjectId, entry.run.run_id, getAssetProjectId(), entry.needsAssets,
          );
          entry.preview = null;
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
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('workflow:canvas-changed', scheduleRefresh);
    document.removeEventListener('workflow:project-changed', onProjectChanged);
  }
  overlay.destroyPipelineOverview = destroy;
  function onKeyDown(event) {
    if (event.key === 'Escape') destroy();
  }
  overlay.querySelector('.modal-close')?.addEventListener('click', destroy);
  if (!host) document.addEventListener('keydown', onKeyDown);
  document.addEventListener('workflow:canvas-changed', scheduleRefresh);
  function onProjectChanged() {
    syncProjectContext().catch(() => {});
  }
  document.addEventListener('workflow:project-changed', onProjectChanged);

  (host || document.body).appendChild(overlay);
}
