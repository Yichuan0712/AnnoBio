/**
 * "Current Pipeline" result panel — opened from the canvas toolbar. Takes the output of
 * pipelineDetection.js's detectPipelines() and renders each detected pipeline as an ordered list
 * of Dataset/Prompt/Process steps, with a picker wherever a step has alternatives — several Prompt
 * versions that each have their own Run, or several datasets that can sit in the same slot.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** A name, or a picker when the slot has alternatives — shared by Prompt versions and the datasets
 * that can sit in one slot, so both read the same way. */
function renderPickerOrName(stepId, options, selectedValue, title) {
  if (options.length === 1) return `<span class="pipeline-step-name">${escapeHtml(options[0].label)}</span>`;
  const optionsHtml = options
    .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === selectedValue ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
    .join('');
  return `<select class="pipeline-step-version-select" data-step-id="${escapeHtml(stepId)}" title="${escapeHtml(title)}">${optionsHtml}</select>`;
}

/** The Runs belonging to a Prompt step's currently selected version, or null for anything without
 * versions to choose between (a Process, a dataset step, a missing step). */
function selectedRunIds(step, selectedByStepId) {
  if (!step || step.kind !== 'prompt') return null;
  const index = parseInt(selectedByStepId.get(step.id), 10);
  const version = step.versions[Number.isInteger(index) ? index : step.defaultVersionIndex] || step.versions[0];
  return new Set(version?.runNodeIds || []);
}

/**
 * Narrows a dataset slot to the Prompt version that's actually selected, so the two pickers can't
 * be combined into a pairing that doesn't exist on the canvas. A slot's datasets are grouped by
 * step, and a step spans a whole version chain, hence the extra filtering here.
 * Falls back to the full list whenever filtering would leave nothing — a Process-produced dataset
 * has no Run to match on, and neither does a dataset whose Run has since been deleted.
 */
function visibleDatasets(step, stepById, selectedByStepId) {
  const all = step.datasets;
  if (step.producerStepId) {
    const runIds = selectedRunIds(stepById.get(step.producerStepId), selectedByStepId);
    if (!runIds) return all;
    const filtered = all.filter((d) => d.producerRunNodeId && runIds.has(d.producerRunNodeId));
    return filtered.length > 0 ? filtered : all;
  }
  if (step.consumerStepId) {
    const runIds = selectedRunIds(stepById.get(step.consumerStepId), selectedByStepId);
    if (!runIds) return all;
    const filtered = all.filter((d) => d.consumerRunNodeIds.some((id) => runIds.has(id)));
    return filtered.length > 0 ? filtered : all;
  }
  return all;
}

function renderStep(step, selectedByStepId, stepById) {
  if (step.kind === 'dataset') {
    const datasets = visibleDatasets(step, stepById, selectedByStepId);
    const selected = selectedByStepId.get(step.id);
    // Picking a Prompt version can filter the previously selected dataset away, so fall back to
    // the first one still standing rather than showing an empty picker.
    const selectedValue = datasets.some((d) => d.datasetNodeId === selected) ? selected : datasets[0]?.datasetNodeId;
    const picker = renderPickerOrName(
      step.id,
      datasets.map((d) => ({ value: d.datasetNodeId, label: d.datasetName })),
      selectedValue,
      'Several datasets can sit in this slot — pick which one this pipeline should use.',
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
  // kind === 'prompt'
  const stored = parseInt(selectedByStepId.get(step.id), 10);
  const index = Number.isInteger(stored) ? stored : step.defaultVersionIndex;
  const picker = renderPickerOrName(
    step.id,
    step.versions.map((v, i) => ({ value: String(i), label: v.promptName })),
    String(index),
    'Multiple versions of this prompt each have their own Run — pick which one this pipeline should use.',
  );
  return `
    <li class="pipeline-overview-step">
      <span class="pipeline-step-kind pipeline-step-kind--prompt">Prompt</span>
      ${picker}
    </li>
  `;
}

function renderPipeline(pipeline, index, selectedByStepId) {
  const stepById = new Map(pipeline.steps.map((s) => [s.id, s]));
  const steps = pipeline.steps
    .map((step) => renderStep(step, selectedByStepId, stepById))
    .join('<li class="pipeline-overview-arrow" aria-hidden="true">&#8594;</li>');
  return `
    <div class="pipeline-overview-card">
      <h3 class="pipeline-overview-card-title">Pipeline ${index + 1}</h3>
      <ol class="pipeline-overview-steps">
        ${steps}
      </ol>
    </div>
  `;
}

/** @param {Array<import('./pipelineDetection.js').Pipeline>} pipelines */
export function showPipelineOverviewModal(pipelines) {
  const overlay = document.createElement('div');
  // Non-modal (see .pipeline-overview-overlay): the canvas stays usable while this is up, so it
  // deliberately doesn't claim aria-modal, dim the page, or lock body scrolling. Dragging and
  // resizing come free from initModalDrag's handling of .modal-panel.
  overlay.className = 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  // Which alternative each multi-option step is showing, kept here rather than read off the
  // <select> because re-rendering replaces the element that fired the change.
  const selectedByStepId = new Map();

  const emptyText = 'No pipelines detected yet — a pipeline needs at least one Prompt with a completed Run, or a Process connected to a Dataset.';

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
    bodyEl.innerHTML = pipelines.length > 0
      ? pipelines.map((p, i) => renderPipeline(p, i, selectedByStepId)).join('')
      : `<p class="pipeline-overview-empty">${escapeHtml(emptyText)}</p>`;
  }
  renderBody();

  bodyEl.addEventListener('change', (e) => {
    const select = e.target.closest?.('.pipeline-step-version-select');
    if (!select) return;
    // Stored as the raw option value: a version index for Prompt steps, a dataset node id for
    // Dataset steps, whose list can be re-filtered underneath an index.
    selectedByStepId.set(select.getAttribute('data-step-id'), select.value);
    renderBody();
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(overlay);
}
