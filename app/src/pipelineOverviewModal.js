/**
 * "Pipeline" panel. A connected workflow is shown as one selectable route of Generate and
 * Process steps; Datasets are not shown. Where several Runs or Processes could come next, that
 * chip becomes a picker and the remainder of the row follows the choice. Branches are drawn only
 * for a Process's named outputs and for the Datasets one Process merges.
 *
 * The chosen route is what Export Python Project exports. Running is done with Run to here on a
 * step (docs/design/RUN_TO_HERE_PLAN.md); its runs are listed in the Run tab.
 */
import { showAlert } from './alertModal.js';
import { iconDownload, iconRun } from './icons.js';

// The export button is an icon; this is its tooltip and accessible name.
const EXPORT_LABEL = 'Export Python Project';
import { layoutPipelineFlow } from './pipelineFlow.js';
import { exportPythonPipeline } from './pipelineExportClient.js';
import { buildSelectedRoute, exportRoutePayload, getVisibleRoute } from './pipelineRouteSelection.js';
import { pipelineDisplayName } from './pipelineNames.js';

const STEP_LABELS = { prompt: 'Generate', process: 'Process' };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
const escapeAttr = value => escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function renderPickerOrName(choiceId, options, selectedValue, title) {
  if (options.length === 1) return `<span class="pipeline-step-name">${escapeHtml(options[0].label)}</span>`;
  const renderOption = (option) => `<option value="${escapeHtml(option.value)}"${option.value === selectedValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`;
  const kinds = [...new Set(options.map((option) => option.kind))];
  const optionsHtml = kinds.length > 1
    ? kinds.map((kind) => `<optgroup label="${escapeHtml(STEP_LABELS[kind] || kind)}">${options.filter((option) => option.kind === kind).map(renderOption).join('')}</optgroup>`).join('')
    : options.map(renderOption).join('');
  return `<select class="pipeline-step-version-select" data-choice-id="${escapeHtml(choiceId)}" aria-label="${escapeHtml(title)}" title="${escapeHtml(options.find(option => option.value === selectedValue)?.label || title)}">${optionsHtml}</select>`;
}

/** The canvas nodes a step stands for: a Generate is its Prompt, Run and input Dataset; Process is its Process and input Datasets. */
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

let nextFlowId = 0;

function renderFlowNode(node) {
  const { step, id, x, y } = node;
  const position = `left:${x}px;top:${y}px`;
  if (step.kind === 'passthrough') return '';
  const kind = step.selectedOption?.kind || step.kind;
  const icon = kind === 'prompt' ? iconRun(16).outerHTML
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';
  const picker = renderPickerOrName(step.choiceId, step.options, step.selectedValue, `Choose ${STEP_LABELS[kind]} step`);
  const name = step.options.find(option => option.value === step.selectedValue)?.label || '';
  return `<div class="pipeline-flow-step" style="${position}" tabindex="0" role="${step.options.length > 1 ? 'group' : 'button'}" aria-label="${escapeHtml(`Locate ${name} on canvas`)}" title="${escapeHtml(name)}" data-flow-node="${id}" data-canvas-node-ids="${encodeURIComponent(JSON.stringify(getCanvasNodeIds(step)))}">
    <span class="pipeline-flow-icon" aria-hidden="true">${icon}</span>
    <div class="pipeline-flow-content"><span class="pipeline-flow-kind">${STEP_LABELS[kind]}</span>${picker}</div>
  </div>`;
}

function renderFlow(route) {
  const graph = layoutPipelineFlow(route);
  const markerId = `pipeline-flow-arrow-${nextFlowId++}`;
  return `<div class="pipeline-flow-viewport" tabindex="0" role="group" aria-label="Pipeline steps; scroll horizontally to see more">
    <div class="pipeline-flow" style="width:${graph.width}px;height:${graph.height}px">
      <svg class="pipeline-flow-connections" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}" aria-hidden="true">
        <defs><marker id="${markerId}" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="m1 1 4 2-4 2" fill="none" stroke="context-stroke" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
        ${graph.edges.map(edge => `<path class="pipeline-flow-connector" data-flow-from="${edge.from}" data-flow-to="${edge.to}" d="${edge.path}"${edge.arrow ? ` marker-end="url(#${markerId})"` : ''}/>`).join('')}
      </svg>
      ${graph.nodes.map(renderFlowNode).join('')}
    </div>
  </div>`;
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

function renderPipeline(pipeline, index, selectedByChoiceId, canRename) {
  const route = buildSelectedRoute(pipeline, selectedByChoiceId);
  const visibleRoute = getVisibleRoute(route);
  const name = pipelineDisplayName(pipeline, index);
  return `
    <div class="pipeline-overview-card" data-pipeline-index="${index}" data-pipeline-id="${escapeHtml(getPipelineViewId(pipeline, index))}" data-pipeline-key="${escapeAttr(pipeline.nameKey || '')}">
      <div class="pipeline-overview-card-header">
        <h3 class="pipeline-overview-card-title">${canRename ? `<button type="button" class="pipeline-overview-name" title="${escapeAttr(`${name} — Click to rename`)}" aria-label="${escapeAttr(`Rename ${name}`)}">${escapeHtml(name)}</button>` : escapeHtml(name)}</h3>
        <div class="pipeline-overview-card-actions">
          <button type="button" class="pipeline-overview-export" data-pipeline-index="${index}" title="${EXPORT_LABEL}" aria-label="${EXPORT_LABEL}">${iconDownload(14).outerHTML}</button>
        </div>
      </div>
      ${renderFlow(visibleRoute)}
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
  let onRenamePipeline = options.onRenamePipeline;
  let editingName = null;
  let finishNameEdit = null;
  let deferredRender = false;
  let pipelines = [];
  let pipelineSignature = '';
  let refreshFrame = 0;

  const overlay = document.createElement('div');
  overlay.className = host ? 'workspace-dock pipeline-overview-overlay' : 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('role', host ? 'region' : 'dialog');
  // Docked, the bottom panel's tab names this view and owns collapse/full-screen, so no header.
  if (host) overlay.setAttribute('aria-label', 'Pipeline');
  else overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  const selectedByChoiceId = new Map();
  // Agent reads the same picker state as the panel instead of rebuilding a default route.
  overlay.getPipelineSelections = () => (readPipelines?.() || []).map((pipeline, index) => ({
    id: getPipelineViewId(pipeline, index),
    name: pipeline.name, nameKey: pipeline.nameKey,
    index,
    route: buildSelectedRoute(pipeline, selectedByChoiceId),
    nodeIds: [...pipelineStepNodeIds(pipeline)],
  }));
  const emptyText = 'No pipelines detected yet.';

  overlay.innerHTML = `
    <div class="modal-panel modal-panel--pipeline-overview">
      ${host ? '' : `<div class="modal-header">
        <h2 id="pipeline-overview-title" class="modal-title">Pipeline</h2>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>`}
      <div class="modal-body pipeline-overview-body"></div>
    </div>
  `;

  const bodyEl = overlay.querySelector('.pipeline-overview-body');

  function clearCanvasHighlight() {
    highlightCanvasNodes([]);
    bodyEl.querySelectorAll('.pipeline-flow-connector.is-active').forEach(edge => edge.classList.remove('is-active'));
  }
  function highlightRouteStep(stepEl) {
    if (!stepEl) {
      clearCanvasHighlight();
      return;
    }
    clearCanvasHighlight();
    const graph = stepEl.closest('.pipeline-flow');
    graph?.querySelectorAll('.pipeline-flow-connector').forEach(edge => {
      edge.classList.toggle('is-active', edge.dataset.flowFrom === stepEl.dataset.flowNode || edge.dataset.flowTo === stepEl.dataset.flowNode);
    });
    try {
      const encodedIds = stepEl.dataset.canvasNodeIds || '';
      const ids = JSON.parse(decodeURIComponent(encodedIds));
      highlightCanvasNodes(Array.isArray(ids) ? ids : []);
    } catch (_) {
      clearCanvasHighlight();
    }
  }
  function renderBody() {
    if (editingName?.isConnected) { deferredRender = true; return; }
    deferredRender = false;
    const scrollPositions = [...bodyEl.querySelectorAll('.pipeline-overview-card')].map(card => [card.dataset.pipelineId, card.querySelector('.pipeline-flow-viewport')?.scrollLeft || 0]);
    const focusChoice = bodyEl.contains(document.activeElement) ? document.activeElement?.dataset.choiceId : null;
    clearCanvasHighlight();
    bodyEl.innerHTML = pipelines.length > 0
      ? pipelines.map((pipeline, index) => renderPipeline(pipeline, index, selectedByChoiceId, typeof onRenamePipeline === 'function')).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
    for (const card of bodyEl.querySelectorAll('.pipeline-overview-card')) {
      const position = scrollPositions.find(([id]) => id === card.dataset.pipelineId);
      if (position) card.querySelector('.pipeline-flow-viewport').scrollLeft = position[1];
    }
    if (focusChoice) {
      [...bodyEl.querySelectorAll('[data-choice-id]')].find(select => select.dataset.choiceId === focusChoice)?.focus({ preventScroll: true });
    }
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
    if (typeof nextOptions.onRenamePipeline === 'function') onRenamePipeline = nextOptions.onRenamePipeline;
  };
  refresh();

  bodyEl.addEventListener('change', (event) => {
    const select = event.target.closest?.('.pipeline-step-version-select');
    if (!select) return;
    selectedByChoiceId.set(select.getAttribute('data-choice-id'), select.value);
    renderBody();
  });

  bodyEl.addEventListener('pointerover', (event) => {
    const stepEl = event.target.closest?.('.pipeline-flow-step');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    highlightRouteStep(stepEl);
  });
  bodyEl.addEventListener('pointerout', (event) => {
    const stepEl = event.target.closest?.('.pipeline-flow-step');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    clearCanvasHighlight();
  });
  bodyEl.addEventListener('focusin', (event) => {
    highlightRouteStep(event.target.closest?.('.pipeline-flow-step'));
  });
  bodyEl.addEventListener('focusout', (event) => {
    const stepEl = event.target.closest?.('.pipeline-flow-step');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    clearCanvasHighlight();
  });

  async function onPanelClick(event) {
    const nameButton = event.target.closest?.('.pipeline-overview-name');
    if (nameButton && typeof onRenamePipeline === 'function') {
      const card = nameButton.closest('.pipeline-overview-card');
      const pipeline = pipelines.find((item, index) => getPipelineViewId(item, index) === card.dataset.pipelineId);
      if (!pipeline?.nameKey) return;
      const nameKey = pipeline.nameKey;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'pipeline-overview-name-input';
      input.value = nameButton.textContent;
      input.size = Math.min(45, Math.max(12, input.value.length + 2));
      input.setAttribute('aria-label', 'Pipeline name');
      editingName = input;
      nameButton.replaceWith(input);
      let finished = false;
      function finish(save, preserveExportTarget = false) {
        if (finished) return;
        finished = true;
        editingName = null;
        finishNameEdit = null;
        try {
          if (save && input.value.trim()) onRenamePipeline(nameKey, input.value.trim());
        } catch (error) {
          showAlert(error.message || 'Could not rename this Pipeline.', { title: 'Rename Pipeline' });
        }
        pipelines = readPipelines?.() || [];
        pipelineSignature = JSON.stringify(pipelines);
        const currentIndex = pipelines.findIndex(item => item.nameKey === nameKey);
        if (currentIndex < 0 || (deferredRender && !preserveExportTarget)) renderBody();
        else {
          const name = pipelineDisplayName(pipelines[currentIndex], currentIndex);
          nameButton.textContent = name;
          nameButton.title = `${name} — Click to rename`;
          nameButton.setAttribute('aria-label', `Rename ${name}`);
          input.replaceWith(nameButton);
        }
      }
      finishNameEdit = finish;
      input.addEventListener('blur', event => finish(true, !!event.relatedTarget?.closest?.('.pipeline-overview-export')));
      input.addEventListener('keydown', event => {
        if (!['Enter', 'Escape'].includes(event.key) || event.isComposing) return;
        event.preventDefault(); event.stopPropagation();
        finish(event.key === 'Enter');
        [...bodyEl.querySelectorAll('.pipeline-overview-card')].find(item => item.dataset.pipelineKey === nameKey)
          ?.querySelector('.pipeline-overview-name')?.focus();
      });
      input.focus(); input.select();
      return;
    }
    if (!event.target.closest('select, button, input, label')) {
      const step = event.target.closest('[data-canvas-node-ids]');
      if (step) focusCanvasNodes(JSON.parse(decodeURIComponent(step.dataset.canvasNodeIds)));
    }
    const button = event.target.closest?.('.pipeline-overview-export');
    if (!button || button.disabled) return;
    finishNameEdit?.(true, true);
    const key = button.closest('.pipeline-overview-card')?.dataset.pipelineKey;
    const pipelineIndex = key ? pipelines.findIndex(item => item.nameKey === key) : Number.parseInt(button.getAttribute('data-pipeline-index') || '', 10);
    const pipeline = pipelines[pipelineIndex];
    if (!pipeline || !getCanvasState) {
      showAlert('The live canvas is unavailable for export.', { title: 'Cannot export Pipeline' });
      return;
    }
    const route = buildSelectedRoute(pipeline, selectedByChoiceId);
    button.disabled = true;
    button.title = 'Exporting…';
    button.setAttribute('aria-label', 'Exporting…');
    try {
      const promptName = route.find((step) => step.selectedOption?.kind === 'prompt')
        ?.selectedOption?.promptName;
      const processName = route.find((step) => step.selectedOption?.kind === 'process')
        ?.selectedOption?.label;
      const stepName = promptName || processName;
      await exportPythonPipeline({
        name: pipeline.name || (stepName ? `${stepName} pipeline` : `pipeline-${pipelineIndex + 1}`),
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
        button.title = EXPORT_LABEL;
        button.setAttribute('aria-label', EXPORT_LABEL);
      }
      if (deferredRender) renderBody();
    }
  }
  // Keep the export target in place until its click: committing on pointerdown blur can move it
  // when the editable input and saved title have different widths.
  bodyEl.addEventListener('pointerdown', event => {
    if (editingName && event.target.closest?.('.pipeline-overview-export')) event.preventDefault();
  });
  bodyEl.addEventListener('click', onPanelClick);

  bodyEl.addEventListener('keydown', (event) => {
    if (!event.target.matches('[data-canvas-node-ids]') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    focusCanvasNodes(JSON.parse(decodeURIComponent(event.target.dataset.canvasNodeIds)));
  });

  function destroy() {
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    finishNameEdit?.(false);
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
