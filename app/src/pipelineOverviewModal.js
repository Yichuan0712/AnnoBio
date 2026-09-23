/**
 * "Current Pipeline" panel. It renders the exact Dataset/Prompt/Process graph returned by
 * pipelineDetection.js, expands branches into separate rows, and keeps its read-only preview in
 * sync while the canvas changes underneath it.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderPickerOrName(stepId, options, selectedValue, title) {
  if (options.length === 1) return `<span class="pipeline-step-name">${escapeHtml(options[0].label)}</span>`;
  const optionsHtml = options
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selectedValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  return `<select class="pipeline-step-version-select" data-step-id="${escapeHtml(stepId)}" title="${escapeHtml(title)}">${optionsHtml}</select>`;
}

function promptRunOptions(step) {
  const options = [];
  for (const version of step?.versions || []) {
    const runs = Array.isArray(version.runs)
      ? version.runs
      : (version.runNodeIds || []).map((runNodeId) => ({ runNodeId, runName: 'Run' }));
    for (const run of runs) {
      options.push({ value: run.runNodeId, promptName: version.promptName, runName: run.runName || 'Run' });
    }
  }
  const needsRunName = options.length > 1;
  return options.map((option) => ({
    ...option,
    label: needsRunName ? `${option.promptName} — ${option.runName}` : option.promptName,
  }));
}

/** A Prompt step selects one concrete Run, rather than only a Prompt version. */
function selectedRunId(step, selectedByStepId) {
  if (!step || step.kind !== 'prompt') return null;
  const options = promptRunOptions(step);
  const stored = selectedByStepId.get(step.id);
  if (options.some((option) => option.value === stored)) return stored;
  if (options.some((option) => option.value === step.defaultRunNodeId)) return step.defaultRunNodeId;
  return options.at(-1)?.value || null;
}

/** Keep only datasets that belong to every concrete Prompt Run selected around this graph slot. */
function visibleDatasets(step, stepById, selectedByStepId) {
  let datasets = step.datasets;
  const producerRunId = selectedRunId(stepById.get(step.producerStepId), selectedByStepId);
  if (producerRunId) {
    datasets = datasets.filter((dataset) => dataset.producerRunNodeId === producerRunId);
  }
  for (const consumerStepId of step.consumerStepIds || []) {
    const consumerRunId = selectedRunId(stepById.get(consumerStepId), selectedByStepId);
    if (consumerRunId) {
      datasets = datasets.filter((dataset) => dataset.consumerRunNodeIds.includes(consumerRunId));
    }
  }
  return datasets;
}

function renderStep(step, selectedByStepId, stepById) {
  if (step.kind === 'dataset') {
    const datasets = visibleDatasets(step, stepById, selectedByStepId);
    if (datasets.length === 0) {
      return `
        <li class="pipeline-overview-step pipeline-overview-step--unavailable">
          <span class="pipeline-step-kind pipeline-step-kind--dataset">Dataset</span>
          <span class="pipeline-step-name">No dataset matches the selected Runs</span>
        </li>
      `;
    }
    const stored = selectedByStepId.get(step.id);
    const selectedValue = datasets.some((dataset) => dataset.datasetNodeId === stored)
      ? stored
      : datasets[0].datasetNodeId;
    const picker = renderPickerOrName(
      step.id,
      datasets.map((dataset) => ({ value: dataset.datasetNodeId, label: dataset.datasetName })),
      selectedValue,
      'Preview one of the datasets that occupies this position on the canvas.',
    );
    return `
      <li class="pipeline-overview-step">
        <span class="pipeline-step-kind pipeline-step-kind--dataset">Dataset</span>
        ${picker}
      </li>
    `;
  }
  if (step.kind === 'process') {
    return `
      <li class="pipeline-overview-step">
        <span class="pipeline-step-kind pipeline-step-kind--process">Process</span>
        <span class="pipeline-step-name">${escapeHtml(step.processName)}</span>
      </li>
    `;
  }

  const options = promptRunOptions(step);
  const selectedValue = selectedRunId(step, selectedByStepId);
  const picker = renderPickerOrName(
    step.id,
    options,
    selectedValue,
    'Preview one concrete Prompt Run and its matching input and output datasets.',
  );
  return `
    <li class="pipeline-overview-step">
      <span class="pipeline-step-kind pipeline-step-kind--prompt">Prompt</span>
      ${picker}
    </li>
  `;
}

/**
 * Expands a DAG into source-to-sink paths. Repeating a shared step in branch rows is intentional:
 * every arrow shown by the panel then corresponds to a real edge instead of implying that two
 * parallel siblings run one after the other.
 */
function buildPipelinePaths(pipeline) {
  const stepIds = new Set(pipeline.steps.map((step) => step.id));
  const edges = (pipeline.edges || []).filter((edge) => stepIds.has(edge.from) && stepIds.has(edge.to));
  if (edges.length === 0) {
    return { paths: pipeline.steps.map((step) => [step.id]), branched: pipeline.steps.length > 1, truncated: false };
  }

  const outgoing = new Map(pipeline.steps.map((step) => [step.id, []]));
  const indegree = new Map(pipeline.steps.map((step) => [step.id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  const branched = [...outgoing.values()].some((next) => next.length > 1)
    || [...indegree.values()].some((count) => count > 1);
  if (!branched) {
    const source = pipeline.steps.find((step) => indegree.get(step.id) === 0);
    const path = [];
    const seen = new Set();
    let current = source?.id;
    while (current && !seen.has(current)) {
      path.push(current);
      seen.add(current);
      current = outgoing.get(current)?.[0];
    }
    return { paths: path.length > 0 ? [path] : pipeline.steps.map((step) => [step.id]), branched: false, truncated: false };
  }

  const paths = [];
  const maxPaths = 100;
  let truncated = false;
  function walk(stepId, path, seen) {
    if (paths.length >= maxPaths) {
      truncated = true;
      return;
    }
    const nextPath = [...path, stepId];
    const nextSeen = new Set(seen).add(stepId);
    const nextIds = (outgoing.get(stepId) || []).filter((id) => !nextSeen.has(id));
    if (nextIds.length === 0) {
      paths.push(nextPath);
      return;
    }
    for (const nextId of nextIds) walk(nextId, nextPath, nextSeen);
  }
  const sources = pipeline.steps.filter((step) => indegree.get(step.id) === 0);
  if (sources.length > 0) {
    for (const source of sources) walk(source.id, [], new Set());
  } else {
    // Malformed cyclic state: show exact edges as two-step rows instead of inventing a sequence.
    for (const edge of edges.slice(0, maxPaths)) paths.push([edge.from, edge.to]);
    truncated = edges.length > maxPaths;
  }
  return { paths, branched: true, truncated };
}

function renderPipeline(pipeline, index, selectedByStepId) {
  const stepById = new Map(pipeline.steps.map((step) => [step.id, step]));
  const { paths, branched, truncated } = buildPipelinePaths(pipeline);
  const rows = paths.map((path, pathIndex) => {
    const steps = path
      .map((stepId) => renderStep(stepById.get(stepId), selectedByStepId, stepById))
      .join('<li class="pipeline-overview-arrow" aria-hidden="true">&#8594;</li>');
    return `
      <div class="pipeline-overview-path">
        ${branched ? `<div class="pipeline-overview-path-label">Branch ${pathIndex + 1}</div>` : ''}
        <ol class="pipeline-overview-steps">${steps}</ol>
      </div>
    `;
  }).join('');
  return `
    <div class="pipeline-overview-card">
      <h3 class="pipeline-overview-card-title">Pipeline ${index + 1}</h3>
      ${rows}
      ${truncated ? '<p class="pipeline-overview-limit">Only the first 100 branches are shown.</p>' : ''}
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
  // Non-modal: the transparent backdrop lets the user keep editing the canvas.
  overlay.className = 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  const selectedByStepId = new Map();
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
      ? pipelines.map((pipeline, index) => renderPipeline(pipeline, index, selectedByStepId)).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
    bodyEl.innerHTML = `
      <p class="pipeline-overview-note">Read-only live preview. Choices here only explore paths already present on the canvas.</p>
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
    selectedByStepId.set(select.getAttribute('data-step-id'), select.value);
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
