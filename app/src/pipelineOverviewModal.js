/**
 * "Current Pipeline" panel. A connected workflow is shown as one selectable route: when several
 * Prompts consume the same Dataset, or one Run produced several Dataset exports, the corresponding
 * chip becomes a picker and the remainder of the row follows that choice.
 */
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
      route.push({ kind: 'dataset', choiceId, options, selectedValue: selected.value });
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
    const displayKind = allPrompts ? 'prompt' : (allProcesses ? 'process' : 'step');
    const displayOptions = nextOptions.map((option) => ({
      ...option,
      label: allPrompts && nextOptions.length > 1
        ? `${option.promptName} — ${option.runName}`
        : option.label || option.promptName,
    }));
    route.push({ kind: displayKind, choiceId, options: displayOptions, selectedValue: selected.value });
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

function renderRouteStep(step) {
  const titles = {
    dataset: 'Preview one of the datasets available at this point in the route.',
    prompt: 'Preview one concrete Prompt Run and follow its connected output.',
    process: 'Preview one Process path.',
    step: 'Preview one of the connected next steps.',
  };
  const labels = { dataset: 'Dataset', prompt: 'Prompt', process: 'Process', step: 'Step' };
  const picker = renderPickerOrName(
    step.choiceId,
    step.options,
    step.selectedValue,
    titles[step.kind],
  );
  return `
    <li class="pipeline-overview-step">
      <span class="pipeline-step-kind pipeline-step-kind--${step.kind}">${labels[step.kind]}</span>
      ${picker}
    </li>
  `;
}

function renderPipeline(pipeline, index, selectedByChoiceId) {
  const route = buildSelectedRoute(pipeline, selectedByChoiceId);
  const steps = route.map(renderRouteStep)
    .join('<li class="pipeline-overview-arrow" aria-hidden="true">&#8594;</li>');
  return `
    <div class="pipeline-overview-card">
      <h3 class="pipeline-overview-card-title">Pipeline ${index + 1}</h3>
      <ol class="pipeline-overview-steps">${steps}</ol>
    </div>
  `;
}

/** @param {Function|Array} pipelineSource a getter for live data, or a static array for callers */
export function showPipelineOverviewModal(pipelineSource) {
  const existing = document.querySelector('.pipeline-overview-overlay');
  if (existing) {
    existing.refreshPipelineOverview?.(pipelineSource);
    existing.querySelector('.modal-close')?.focus();
    return;
  }

  let readPipelines = typeof pipelineSource === 'function' ? pipelineSource : () => pipelineSource;
  let pipelines = [];
  let pipelineSignature = '';
  let refreshFrame = 0;

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

  const bodyEl = overlay.querySelector('.pipeline-overview-body');
  function renderBody() {
    const content = pipelines.length > 0
      ? pipelines.map((pipeline, index) => renderPipeline(pipeline, index, selectedByChoiceId)).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
    bodyEl.innerHTML = `
      <p class="pipeline-overview-note">Read-only live preview. Change a picker to follow another route already present on the canvas.</p>
      ${content}
    `;
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
  refresh();

  bodyEl.addEventListener('change', (event) => {
    const select = event.target.closest?.('.pipeline-step-version-select');
    if (!select) return;
    selectedByChoiceId.set(select.getAttribute('data-choice-id'), select.value);
    renderBody();
  });

  function close() {
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
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
