/**
 * "Current Pipeline" panel. A connected workflow is shown as one selectable route of Generate and
 * Process data steps; Datasets are not shown. Where several Runs or Processes could come next, that
 * chip becomes a picker and the remainder of the row follows the choice. Branches are drawn only
 * for a Process's named outputs and for the Datasets one Process merges.
 *
 * The chosen route is what Export Python Project exports. Running is done with Run to here on a
 * step (docs/design/RUN_TO_HERE_PLAN.md); its runs are listed in the Executions tab.
 */
import { showAlert } from './alertModal.js';
import { exportPythonPipeline } from './pipelineExportClient.js';
import { buildSelectedRoute, exportRoutePayload, getVisibleRoute } from './pipelineRouteSelection.js';

const STEP_LABELS = { prompt: 'Generate', process: 'Process data' };

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

/** The canvas nodes a step stands for: a Generate is its Prompt, Run and input Dataset; Process data is its Process and input Datasets. */
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
    step.kind === 'prompt' ? 'Preview one concrete Prompt/Generate step in this branch.' : 'Preview this Process path.',
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
    prompt: 'Preview one concrete Prompt/Generate step and follow its connected output.',
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

/** Generate and Process node ids in a detected pipeline. */
function pipelineStepNodeIds(pipeline) {
  const ids = new Set();
  for (const step of pipeline?.steps || []) {
    if (step.kind === 'process') ids.add(step.processNodeId);
    for (const version of step.versions || []) for (const id of version.runNodeIds || []) ids.add(id);
  }
  return ids;
}

function renderPipeline(pipeline, index, selectedByChoiceId) {
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
          <button type="button" class="btn btn-secondary pipeline-overview-export" data-pipeline-index="${index}">Export Python Project</button>
        </div>
      </div>
      <ol class="pipeline-overview-steps">${steps}</ol>
    </div>
  `;
}

/**
 * @param {Function|Array} pipelineSource a getter for live data, or a static array for callers
 * @param {{getCanvasState?: Function, highlightCanvasNodes?: Function, focusCanvasNodes?: Function,
 *   host?: HTMLElement}} options live canvas hooks; with `host` it is docked in the bottom panel
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
  let pipelines = [];
  let pipelineSignature = '';
  let refreshFrame = 0;

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
  const emptyText = 'No pipelines detected yet — a pipeline needs at least one Prompt with a Generate, or a Process.';

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
    bodyEl.innerHTML = pipelines.length > 0
      ? pipelines.map((pipeline, index) => renderPipeline(pipeline, index, selectedByChoiceId)).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
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

  async function onPanelClick(event) {
    if (!event.target.closest('select, button, input, label')) {
      const step = event.target.closest('[data-canvas-node-ids]');
      if (step) focusCanvasNodes(JSON.parse(decodeURIComponent(step.dataset.canvasNodeIds)));
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

  bodyEl.addEventListener('keydown', (event) => {
    if (!event.target.matches('[data-canvas-node-ids]') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    focusCanvasNodes(JSON.parse(decodeURIComponent(event.target.dataset.canvasNodeIds)));
  });

  function destroy() {
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    clearCanvasHighlight();
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('workflow:canvas-changed', scheduleRefresh);
    document.removeEventListener('workflow:history-resolved', scheduleRefresh);
    document.removeEventListener('workflow:process-outputs-changed', scheduleRefresh);
  }
  overlay.destroyPipelineOverview = destroy;
  function onKeyDown(event) {
    if (event.key === 'Escape') destroy();
  }
  overlay.querySelector('.modal-close')?.addEventListener('click', destroy);
  if (!host) document.addEventListener('keydown', onKeyDown);
  document.addEventListener('workflow:canvas-changed', scheduleRefresh);
  document.addEventListener('workflow:history-resolved', scheduleRefresh);
  // A Process's branches are detected from its code after it changes (processOutputPorts.js).
  document.addEventListener('workflow:process-outputs-changed', scheduleRefresh);

  (host || document.body).appendChild(overlay);
}
