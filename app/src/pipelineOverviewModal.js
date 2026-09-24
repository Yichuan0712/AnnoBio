/**
 * "Current Pipeline" panel. A connected workflow is shown as one selectable route: when several
 * Prompts consume the same Dataset, or one Run produced several Dataset exports, the corresponding
 * chip becomes a picker and the remainder of the row follows that choice.
 */
import { showAlert } from './alertModal.js';
import { exportPythonPipeline } from './pipelineExportClient.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderPickerOrName(choiceId, options, selectedValue, title) {
  if (options.length === 1) return `<span class="pipeline-step-name">${escapeHtml(options[0].label)}</span>`;
  const optionsHtml = options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selectedValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  return `<select class="pipeline-step-version-select" data-choice-id="${escapeHtml(choiceId)}" title="${escapeHtml(title)}">${optionsHtml}</select>`;
}

function promptRunOptions(step) {
  const options = [];
  for (const version of step?.versions || []) {
    const runs = Array.isArray(version.runs)
      ? version.runs
      : (version.runNodeIds || []).map((runNodeId) => ({ runNodeId, runName: 'Run' }));
    for (const run of runs) {
      options.push({
        value: run.runNodeId,
        stepId: step.id,
        promptNodeId: version.promptNodeId,
        runNodeId: run.runNodeId,
        promptName: version.promptName,
        runName: run.runName || 'Run',
        kind: 'prompt',
      });
    }
  }
  return options;
}

function chooseOption(choiceId, options, selectedByChoiceId, preferredValue = '') {
  const stored = selectedByChoiceId.get(choiceId);
  return options.find((option) => option.value === stored)
    || options.find((option) => option.value === preferredValue)
    || options[0]
    || null;
}

/**
 * Resolves one route through the workflow graph. Choices are made at the node where paths diverge,
 * so shared prefixes and suffixes appear once instead of being repeated as Branch 1/2/3 rows.
 */
function buildSelectedRoute(pipeline, selectedByChoiceId) {
  const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const outgoing = new Map(steps.map((step) => [step.id, []]));
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  for (const edge of pipeline?.edges || []) {
    if (!stepById.has(edge.from) || !stepById.has(edge.to)) continue;
    if (!outgoing.get(edge.from).includes(edge.to)) outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const route = [];
  const visitedStepIds = new Set();
  const selectedRunByStepId = new Map();

  function walk(candidateStepIds, allowedRunIds = null) {
    if (route.length >= 200) return;
    const candidateSteps = candidateStepIds
      .map((id) => stepById.get(id))
      .filter((step) => step && !visitedStepIds.has(step.id));
    if (candidateSteps.length === 0) return;

    if (candidateSteps.every((step) => step.kind === 'dataset')) {
      const choiceId = candidateSteps.length === 1
        ? candidateSteps[0].id
        : `dataset-choice:${candidateSteps.map((step) => step.id).sort().join('|')}`;
      const options = [];
      for (const step of candidateSteps) {
        const producerRunId = selectedRunByStepId.get(step.producerStepId) || null;
        const datasets = producerRunId
          ? step.datasets.filter((dataset) => dataset.producerRunNodeId === producerRunId)
          : step.datasets;
        for (const dataset of datasets) {
          options.push({
            value: dataset.datasetNodeId,
            label: dataset.datasetName,
            dataset,
            stepId: step.id,
          });
        }
      }
      const selected = chooseOption(choiceId, options, selectedByChoiceId);
      if (!selected) return;
      route.push({ kind: 'dataset', choiceId, options, selectedValue: selected.value, selectedOption: selected });
      visitedStepIds.add(selected.stepId);
      const consumerStepIds = selected.dataset.consumerStepIds
        || stepById.get(selected.stepId)?.consumerStepIds
        || [];
      walk(consumerStepIds, new Set(selected.dataset.consumerRunNodeIds || []));
      return;
    }

    const nextOptions = [];
    const restrictPromptRuns = allowedRunIds instanceof Set && allowedRunIds.size > 0;
    for (const step of candidateSteps) {
      if (step.kind === 'prompt') {
        for (const option of promptRunOptions(step)) {
          if (!restrictPromptRuns || allowedRunIds.has(option.runNodeId)) nextOptions.push(option);
        }
      } else if (step.kind === 'process') {
        nextOptions.push({
          value: `process:${step.processNodeId}`,
          label: step.processName,
          stepId: step.id,
          processNodeId: step.processNodeId,
          inputDatasets: Array.isArray(step.inputDatasets) ? step.inputDatasets : [],
          kind: 'process',
        });
      }
    }
    if (nextOptions.length === 0) return;

    const choiceId = candidateSteps.length === 1
      ? candidateSteps[0].id
      : `step-choice:${candidateSteps.map((step) => step.id).sort().join('|')}`;
    const firstPromptStep = candidateSteps.find((step) => step.kind === 'prompt');
    const preferredValue = firstPromptStep?.defaultRunNodeId || '';
    const selected = chooseOption(choiceId, nextOptions, selectedByChoiceId, preferredValue);
    if (!selected) return;

    const allPrompts = nextOptions.every((option) => option.kind === 'prompt');
    const allProcesses = nextOptions.every((option) => option.kind === 'process');
    const displayKind = allPrompts
      ? 'prompt'
      : (allProcesses && selected.inputDatasets?.length > 1 ? 'merge' : (allProcesses ? 'process' : 'step'));
    const displayOptions = nextOptions.map((option) => ({
      ...option,
      label: allPrompts && nextOptions.length > 1
        ? `${option.promptName} — ${option.runName}`
        : option.label || option.promptName,
    }));
    route.push({
      kind: displayKind,
      choiceId,
      options: displayOptions,
      selectedValue: selected.value,
      selectedOption: selected,
    });
    visitedStepIds.add(selected.stepId);
    if (selected.kind === 'prompt') selectedRunByStepId.set(selected.stepId, selected.runNodeId);
    const nextStepIds = (outgoing.get(selected.stepId) || [])
      .filter((id) => stepById.get(id)?.kind === 'dataset');
    walk(nextStepIds);
  }

  const sourceIds = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  walk(sourceIds);
  return route;
}

function exportRoutePayload(route) {
  return route.map((step) => {
    const selected = step.selectedOption;
    if (selected?.dataset) {
      return { type: 'dataset', dataset_node_id: selected.dataset.datasetNodeId };
    }
    if (selected?.kind === 'prompt') {
      return {
        type: 'prompt',
        prompt_node_id: selected.promptNodeId,
        run_node_id: selected.runNodeId,
      };
    }
    if (selected?.kind === 'process') {
      return { type: 'process', process_node_id: selected.processNodeId };
    }
    return null;
  }).filter(Boolean);
}

function getCanvasNodeIds(step) {
  const selected = step.selectedOption;
  if (selected?.dataset?.datasetNodeId) return [selected.dataset.datasetNodeId];
  if (selected?.kind === 'prompt') {
    return [selected.promptNodeId, selected.runNodeId].filter(Boolean);
  }
  if (selected?.kind === 'process' && selected.processNodeId) {
    return [selected.processNodeId, ...(selected.inputDatasets || []).map((input) => input.datasetNodeId)].filter(Boolean);
  }
  return [];
}

function renderRouteStep(step) {
  const titles = {
    dataset: 'Preview one of the datasets available at this point in the route.',
    prompt: 'Preview one concrete Prompt Run and follow its connected output.',
    process: 'Preview one Process path.',
    merge: 'This Process combines all listed Dataset inputs before it runs.',
    step: 'Preview one of the connected next steps.',
  };
  const labels = { dataset: 'Dataset', prompt: 'Prompt', process: 'Process', merge: 'Merge', step: 'Step' };
  const picker = renderPickerOrName(
    step.choiceId,
    step.options,
    step.selectedValue,
    titles[step.kind],
  );
  const canvasNodeIds = encodeURIComponent(JSON.stringify(getCanvasNodeIds(step)));
  const mergeInputs = step.kind === 'merge'
    ? `<span class="pipeline-step-merge-inputs">${(step.selectedOption?.inputDatasets || [])
      .map((input) => escapeHtml(input.datasetName || 'Dataset')).join(' + ')}</span>`
    : '';
  return `
    <li class="pipeline-overview-step" data-canvas-node-ids="${canvasNodeIds}">
      <span class="pipeline-step-kind pipeline-step-kind--${step.kind}">${labels[step.kind]}</span>
      ${picker}
      ${mergeInputs}
    </li>
  `;
}

function getVisibleRoute(route, hideIntermediateDatasets) {
  if (!hideIntermediateDatasets) return route;
  const firstDatasetIndex = route.findIndex((step) => step.kind === 'dataset');
  return route.filter((step, index) => step.kind !== 'dataset' || index === firstDatasetIndex);
}

function getPipelineViewId(pipeline, index) {
  return String(pipeline?.id || `pipeline-index-${index}`);
}

function renderPipeline(pipeline, index, selectedByChoiceId, hideIntermediateDatasets) {
  const route = buildSelectedRoute(pipeline, selectedByChoiceId);
  const visibleRoute = getVisibleRoute(route, hideIntermediateDatasets);
  const steps = visibleRoute.map(renderRouteStep)
    .join('<li class="pipeline-overview-arrow" aria-hidden="true">&#8594;</li>');
  return `
    <div class="pipeline-overview-card" data-pipeline-index="${index}">
      <div class="pipeline-overview-card-header">
        <h3 class="pipeline-overview-card-title">Pipeline ${index + 1}</h3>
        <div class="pipeline-overview-card-actions">
          <label class="rule-editor-checkbox-label pipeline-overview-data-checkbox">
            <input type="checkbox" class="rule-editor-checkbox pipeline-overview-data-toggle-input" data-pipeline-index="${index}"${hideIntermediateDatasets ? ' checked' : ''}>
            <span>Hide data nodes</span>
          </label>
          <button type="button" class="btn btn-secondary pipeline-overview-export" data-pipeline-index="${index}">Export Python Project</button>
        </div>
      </div>
      <ol class="pipeline-overview-steps">${steps}</ol>
    </div>
  `;
}

/**
 * @param {Function|Array} pipelineSource a getter for live data, or a static array for callers
 * @param {{getCanvasState?: Function, highlightCanvasNodes?: Function}} options live canvas hooks
 */
export function showPipelineOverviewModal(pipelineSource, options = {}) {
  const existing = document.querySelector('.pipeline-overview-overlay');
  if (existing) {
    existing.refreshPipelineOverview?.(pipelineSource);
    existing.setPipelineOverviewOptions?.(options);
    existing.querySelector('.modal-close')?.focus();
    return;
  }

  let readPipelines = typeof pipelineSource === 'function' ? pipelineSource : () => pipelineSource;
  let getCanvasState = typeof options.getCanvasState === 'function' ? options.getCanvasState : null;
  let highlightCanvasNodes = typeof options.highlightCanvasNodes === 'function'
    ? options.highlightCanvasNodes
    : () => {};
  let pipelines = [];
  let pipelineSignature = '';
  let refreshFrame = 0;
  const showIntermediateDatasetsByPipelineId = new Map();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  const selectedByChoiceId = new Map();
  const emptyText = 'No pipelines detected yet — a pipeline needs at least one Prompt that has a Run.';

  overlay.innerHTML = `
    <div class="modal-panel modal-panel--pipeline-overview">
      <div class="modal-header">
        <h2 id="pipeline-overview-title" class="modal-title">Current Pipeline</h2>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body pipeline-overview-body"></div>
    </div>
  `;

  const panelEl = overlay.querySelector('.modal-panel--pipeline-overview');
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
      const ids = JSON.parse(decodeURIComponent(stepEl.dataset.canvasNodeIds || ''));
      highlightCanvasNodes(Array.isArray(ids) ? ids : []);
    } catch (_) {
      clearCanvasHighlight();
    }
  }
  function renderBody({ fitHeightToContent = false } = {}) {
    clearCanvasHighlight();
    const content = pipelines.length > 0
      ? pipelines.map((pipeline, index) => renderPipeline(
        pipeline,
        index,
        selectedByChoiceId,
        showIntermediateDatasetsByPipelineId.get(getPipelineViewId(pipeline, index)) !== true,
      )).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
    bodyEl.innerHTML = content;
    if (fitHeightToContent && !overlay.classList.contains('modal-overlay--maximized')) {
      panelEl.style.removeProperty('height');
    }
  }
  function refresh(nextSource) {
    if (typeof nextSource === 'function') readPipelines = nextSource;
    const nextPipelines = readPipelines?.() || [];
    const nextSignature = JSON.stringify(nextPipelines);
    if (nextSignature === pipelineSignature) return;
    pipelines = nextPipelines;
    pipelineSignature = nextSignature;
    renderBody();
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
  };
  refresh();

  bodyEl.addEventListener('change', (event) => {
    const dataToggle = event.target.closest?.('.pipeline-overview-data-toggle-input');
    if (dataToggle) {
      const pipelineIndex = Number.parseInt(dataToggle.getAttribute('data-pipeline-index') || '', 10);
      const pipeline = pipelines[pipelineIndex];
      if (pipeline) {
        showIntermediateDatasetsByPipelineId.set(
          getPipelineViewId(pipeline, pipelineIndex),
          !dataToggle.checked,
        );
        renderBody({ fitHeightToContent: true });
      }
      return;
    }
    const select = event.target.closest?.('.pipeline-step-version-select');
    if (!select) return;
    selectedByChoiceId.set(select.getAttribute('data-choice-id'), select.value);
    renderBody();
  });

  bodyEl.addEventListener('pointerover', (event) => {
    const stepEl = event.target.closest?.('.pipeline-overview-step');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    highlightRouteStep(stepEl);
  });
  bodyEl.addEventListener('pointerout', (event) => {
    const stepEl = event.target.closest?.('.pipeline-overview-step');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    clearCanvasHighlight();
  });
  bodyEl.addEventListener('focusin', (event) => {
    highlightRouteStep(event.target.closest?.('.pipeline-overview-step'));
  });
  bodyEl.addEventListener('focusout', (event) => {
    const stepEl = event.target.closest?.('.pipeline-overview-step');
    if (!stepEl || stepEl.contains(event.relatedTarget)) return;
    clearCanvasHighlight();
  });

  bodyEl.addEventListener('click', async (event) => {
    const button = event.target.closest?.('.pipeline-overview-export');
    if (!button || button.disabled) return;
    const pipelineIndex = Number.parseInt(button.getAttribute('data-pipeline-index') || '', 10);
    const pipeline = pipelines[pipelineIndex];
    if (!pipeline || !getCanvasState) {
      showAlert('The live canvas is unavailable for export.', { title: 'Cannot export Pipeline' });
      return;
    }
    const route = buildSelectedRoute(pipeline, selectedByChoiceId);
    const merge = route.find((step) => step.kind === 'merge');
    if (merge) {
      showAlert('Python export for a Pipeline with merged Dataset inputs is not available yet. Save the Merge Process output as one Dataset, then export the downstream route.', {
        title: 'Cannot export Pipeline',
      });
      return;
    }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Exporting…';
    try {
      const promptName = route.find((step) => step.selectedOption?.kind === 'prompt')
        ?.selectedOption?.promptName;
      await exportPythonPipeline({
        name: promptName ? `${promptName} pipeline` : `pipeline-${pipelineIndex + 1}`,
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

  function close() {
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    clearCanvasHighlight();
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('workflow:canvas-changed', scheduleRefresh);
  }
  function onKeyDown(event) {
    if (event.key === 'Escape') close();
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('workflow:canvas-changed', scheduleRefresh);

  document.body.appendChild(overlay);
}
