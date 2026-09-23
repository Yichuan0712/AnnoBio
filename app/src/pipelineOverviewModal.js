/**
 * "My Pipeline" result modal — opened from the canvas toolbar. Takes the output of
 * pipelineDetection.js's detectPipelines() and renders each detected pipeline as an ordered list
 * of Prompt/Process steps, with a version picker wherever a Prompt step is ambiguous (more than
 * one version in its prompt-to-prompt chain has its own Run).
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderStep(step) {
  if (step.kind === 'process') {
    return `
      <li class="pipeline-overview-step">
        <span class="pipeline-step-kind pipeline-step-kind--process">Process</span>
        <span class="pipeline-step-name">${escapeHtml(step.processName)}</span>
      </li>
    `;
  }
  // kind === 'prompt'
  if (step.versions.length === 1) {
    return `
      <li class="pipeline-overview-step">
        <span class="pipeline-step-kind pipeline-step-kind--prompt">Prompt</span>
        <span class="pipeline-step-name">${escapeHtml(step.versions[0].promptName)}</span>
      </li>
    `;
  }
  const options = step.versions
    .map((v, i) => `<option value="${i}"${i === step.defaultVersionIndex ? ' selected' : ''}>${escapeHtml(v.promptName)}</option>`)
    .join('');
  return `
    <li class="pipeline-overview-step">
      <span class="pipeline-step-kind pipeline-step-kind--prompt">Prompt</span>
      <select class="pipeline-step-version-select" data-step-id="${escapeHtml(step.id)}" title="Multiple versions of this prompt each have their own Run — pick which one this pipeline should use.">
        ${options}
      </select>
    </li>
  `;
}

function renderPipeline(pipeline, index) {
  return `
    <div class="pipeline-overview-card">
      <h3 class="pipeline-overview-card-title">Pipeline ${index + 1}</h3>
      <ol class="pipeline-overview-steps">
        ${pipeline.steps.map(renderStep).join('<li class="pipeline-overview-arrow" aria-hidden="true">&#8594;</li>')}
      </ol>
    </div>
  `;
}

/** @param {Array<import('./pipelineDetection.js').Pipeline>} pipelines */
export function showPipelineOverviewModal(pipelines) {
  const overlay = document.createElement('div');
  // The canvas toolbar stays clickable while the Agent Assistant window is up, so this can open
  // over it — and that overlay sits at z-index 2000 (see agentWindow.css), which a plain
  // z-index 1000 would render underneath instead of on top.
  overlay.className = 'modal-overlay pipeline-overview-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pipeline-overview-title');

  const body = pipelines.length > 0
    ? pipelines.map(renderPipeline).join('')
    : `<p class="pipeline-overview-empty">No pipelines detected yet — a pipeline needs at least one Prompt with a completed Run, or a Process connected to a Dataset.</p>`;

  overlay.innerHTML = `
    <div class="modal-panel modal-panel--pipeline-overview">
      <div class="modal-header">
        <h2 id="pipeline-overview-title" class="modal-title">My Pipeline</h2>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body pipeline-overview-body">
        ${body}
      </div>
    </div>
  `;

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKeyDown);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKeyDown);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
