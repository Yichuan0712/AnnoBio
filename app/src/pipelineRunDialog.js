/**
 * Run Pipeline: a card for each step that reads a Dataset from outside the Pipeline, showing what it
 * reads. Inputs are connected on the canvas, so clicking a card closes the dialog and shows that node
 * there. Run starts only once the Pipeline checks out, and a problem is shown on the card of the node
 * it concerns.
 */
import { datasetColorAt } from './workflowNodeColors.js';

const STEP_LABELS = { run: 'Run prompt', process: 'Process data' };

/** One step and several steps get different sentences, and so does one Dataset versus several. */
export function pipelineRunIntro(steps) {
  const datasetCount = steps.reduce((count, step) => count + step.inputs.length, 0);
  if (steps.length === 1) {
    return datasetCount === 1
      ? 'This step reads a Dataset from outside the Pipeline. To read another, click it to find it on the canvas and drag another Dataset onto its input.'
      : 'This step reads Datasets from outside the Pipeline. To change them, click it to find it on the canvas and drag other Datasets onto its inputs.';
  }
  return 'These steps read Datasets from outside the Pipeline. To change what one reads, click it to find it on the canvas and drag another Dataset onto its input.';
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function stepHtml(step, problems) {
  const datasets = step.inputs.map((input) => `<span class="pipeline-run-dialog__dataset">
      <span class="run-detail-ws-option-color" style="background:${escapeHtml(datasetColorAt(input.colorIndex ?? 0))}" aria-hidden="true"></span>
      <span>${escapeHtml(input.name)}</span>
    </span>`).join('');
  const kind = step.kind === 'run' ? 'prompt' : 'process';
  return `<button type="button" class="pipeline-run-dialog__step${problems.length ? ' has-problem' : ''}" data-node-id="${escapeHtml(step.nodeId)}" title="Show on the canvas">
    <span class="pipeline-run-dialog__step-head">
      <span class="pipeline-step-kind pipeline-step-kind--${kind}">${STEP_LABELS[step.kind]}</span>
      <span class="pipeline-run-dialog__step-name">${escapeHtml(step.name)}</span>
      <span class="pipeline-run-dialog__open" aria-hidden="true">›</span>
    </span>
    <span class="pipeline-run-dialog__datasets">${datasets}</span>
    ${problems.map((problem) => `<span class="pipeline-run-dialog__problem">${escapeHtml(problem)}</span>`).join('')}
  </button>`;
}

/**
 * @param {{ getSteps: () => ReturnType<import('./pipelineRunInputs.js').pipelineInputSteps>,
 *   showNode: (nodeId: string) => void,
 *   check: () => Promise<Array<{ nodeId?: string, nodeName?: string, message: string }>> }} options
 *   check: compiles the Pipeline as the canvas now is and returns what keeps it from running
 * @returns {Promise<boolean>} whether to start the run
 */
export function openPipelineRunDialog({ getSteps, showNode, check }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--alert';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pipeline-run-dialog-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--alert pipeline-run-dialog">
      <div class="modal-header">
        <h2 id="pipeline-run-dialog-title" class="modal-title">Prepare inputs for this run</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body pipeline-run-dialog__body">
        <p class="pipeline-run-dialog__intro"></p>
        <div class="pipeline-run-dialog__steps"></div>
        <ul class="pipeline-run-dialog__errors" role="alert" hidden></ul>
      </div>
      <div class="modal-alert-footer">
        <button type="button" class="btn btn-secondary pipeline-run-dialog__cancel">Cancel</button>
        <button type="button" class="btn btn-primary pipeline-run-dialog__run">Run</button>
      </div>
    </div>
  `;
  const stepsEl = overlay.querySelector('.pipeline-run-dialog__steps');
  const errorsEl = overlay.querySelector('.pipeline-run-dialog__errors');
  const runBtn = overlay.querySelector('.pipeline-run-dialog__run');
  let errors = [];

  function render() {
    const steps = getSteps();
    const stepOf = (error) => steps.find((step) => step.nodeId === error.nodeId
      || step.inputs.some((input) => input.nodeId === error.nodeId));
    stepsEl.innerHTML = steps.map((step) => stepHtml(step, errors.filter((error) => stepOf(error) === step)
      .map((error) => error.message))).join('');
    const others = errors.filter((error) => !stepOf(error));
    errorsEl.innerHTML = others.map((error) => `<li>${escapeHtml(error.nodeName ? `${error.nodeName}: ${error.message}` : error.message)}</li>`).join('');
    errorsEl.hidden = !others.length;
    const intro = overlay.querySelector('.pipeline-run-dialog__intro');
    intro.textContent = pipelineRunIntro(steps);
    intro.hidden = !steps.length;
  }
  // The canvas can change while the dialog is open (a Run finishing); problems are checked again on Run.
  function onCanvasChanged() {
    errors = [];
    render();
  }

  return new Promise((resolve) => {
    let checking = false;
    function done(value) {
      overlay.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('workflow:canvas-changed', onCanvasChanged);
      resolve(value);
    }
    function onKeyDown(event) {
      // A window opened above this dialog takes its own Escape.
      const overlays = document.querySelectorAll('.modal-overlay');
      if (event.key === 'Escape' && !checking && overlays[overlays.length - 1] === overlay) done(false);
    }
    async function run() {
      checking = true;
      runBtn.disabled = true;
      runBtn.textContent = 'Checking…';
      try {
        errors = await check();
      } catch (error) {
        errors = [{ message: error instanceof Error ? error.message : String(error) }];
      }
      checking = false;
      if (!overlay.isConnected) return;
      if (!errors.length) {
        done(true);
        return;
      }
      render();
      runBtn.disabled = false;
      runBtn.textContent = 'Run';
    }
    stepsEl.addEventListener('click', (event) => {
      const card = event.target.closest('.pipeline-run-dialog__step');
      if (!card || checking) return;
      done(false);
      showNode(card.dataset.nodeId);
    });
    overlay.querySelector('.modal-close').addEventListener('click', () => { if (!checking) done(false); });
    overlay.querySelector('.pipeline-run-dialog__cancel').addEventListener('click', () => { if (!checking) done(false); });
    overlay.addEventListener('click', (event) => { if (event.target === overlay && !checking) done(false); });
    runBtn.addEventListener('click', () => { void run(); });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('workflow:canvas-changed', onCanvasChanged);
    render();
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  });
}
