/**
 * The plan shown before Run to here starts steps upstream of the one asked for
 * (docs/design/RUN_TO_HERE_PLAN.md step 3): what it reads, which results it reuses and which steps it
 * runs, in order. A step card shows that node on the canvas. Problems keep it from starting.
 */

const KIND_LABELS = { run: 'Run prompt', process: 'Process data' };

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const plural = (count, word) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/**
 * What the dialog says, from a runPlan.js plan. Pure.
 * @param {ReturnType<import('./runPlan.js').planRunTo>} plan
 * @param {{ modelLabel?: (credentialId: string) => string }} options
 */
export function runPlanView(plan, { modelLabel = (id) => id } = {}) {
  const names = new Map(plan.steps.map((step) => [step.nodeId, step.name]));
  const problemsOf = (nodeId) => plan.problems.filter((problem) => problem.nodeId === nodeId).map((problem) => problem.message);
  const card = (step) => {
    let detail = '';
    if (step.action !== 'reuse') {
      if (step.kind === 'process') detail = 'Runs its Python code';
      else {
        const calls = step.calls == null ? 'model calls unknown until the steps before it finish' : plural(step.calls, 'model call');
        detail = `${step.credentialId ? `${modelLabel(step.credentialId)} · ` : ''}${calls}`;
      }
      if (step.action === 'resume') detail += step.kind === 'run' ? ' · continues where it stopped' : ' · runs again from the start';
      if (step.action === 'rerun') detail += ' · runs again: it already has a current result';
    }
    return { nodeId: step.nodeId, kind: step.kind, name: step.name, detail, problems: problemsOf(step.nodeId) };
  };
  const stepIds = new Set(plan.steps.map((step) => step.nodeId));
  const target = plan.steps.at(-1);
  return {
    title: `${plan.scope === 'this' ? 'Execute' : 'Execute to'} "${target?.name || 'this step'}"`,
    inputs: plan.inputs.map((input) => ({
      nodeId: input.nodeId,
      text: `${input.name} · ${input.rows == null ? 'unknown rows' : plural(input.rows, 'row')} · read by ${input.readBy.map((id) => names.get(id) || id).join(', ')}`,
      problems: problemsOf(input.nodeId),
    })),
    reused: plan.steps.filter((step) => step.action === 'reuse').map(card),
    toRun: plan.steps.filter((step) => step.action !== 'reuse').map(card),
    // Problems not about a step or input of this plan (for example the target itself is not a step).
    otherProblems: plan.problems.filter((problem) => !stepIds.has(problem.nodeId) && !plan.inputs.some((input) => input.nodeId === problem.nodeId))
      .map((problem) => problem.message),
    // Only when a Run will run: Process steps make no model calls.
    calls: !plan.steps.some((step) => step.kind === 'run' && step.action !== 'reuse') ? ''
      : plan.calls == null ? 'Model calls: unknown until earlier steps finish.' : `Model calls: ${plan.calls.toLocaleString('en-US')}`,
    hasProblems: plan.problems.length > 0,
    canStart: !plan.problems.length && plan.toRun > 0,
  };
}

function cardHtml(item) {
  return `<button type="button" class="run-plan-dialog__step${item.problems.length ? ' has-problem' : ''}" data-node-id="${escapeHtml(item.nodeId)}" title="Show on the canvas">
    <span class="run-plan-dialog__step-head">
      <span class="pipeline-step-kind pipeline-step-kind--${item.kind === 'run' ? 'prompt' : 'process'}">${KIND_LABELS[item.kind]}</span>
      <span class="run-plan-dialog__step-name">${escapeHtml(item.name)}</span>
      <span class="run-plan-dialog__open" aria-hidden="true">›</span>
    </span>
    ${item.detail ? `<span class="run-plan-dialog__detail">${escapeHtml(item.detail)}</span>` : ''}
    ${item.problems.map((problem) => `<span class="run-plan-dialog__problem">${escapeHtml(problem)}</span>`).join('')}
  </button>`;
}

function sectionHtml(title, body) {
  return body ? `<section class="run-plan-dialog__section"><h3 class="run-plan-dialog__heading">${escapeHtml(title)}</h3>${body}</section>` : '';
}

/**
 * @param {{ plan: object, modelLabel?: (id: string) => string, showNode: (nodeId: string) => void }} options
 * @returns {Promise<boolean>} whether to start
 */
export function openRunPlanDialog({ plan, modelLabel, showNode }) {
  const view = runPlanView(plan, { modelLabel });
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay modal-overlay--alert';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'run-plan-dialog-title');
  const inputs = view.inputs.map((input) => `<li class="run-plan-dialog__input">${escapeHtml(input.text)}${input.problems.map((problem) => `<span class="run-plan-dialog__problem">${escapeHtml(problem)}</span>`).join('')}</li>`).join('');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--alert run-plan-dialog">
      <div class="modal-header">
        <h2 id="run-plan-dialog-title" class="modal-title">${escapeHtml(view.title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body run-plan-dialog__body">
        ${view.otherProblems.length ? `<ul class="run-plan-dialog__errors" role="alert">${view.otherProblems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>` : ''}
        ${sectionHtml('Reads', inputs ? `<ul class="run-plan-dialog__inputs">${inputs}</ul>` : '')}
        ${sectionHtml('Uses existing results', view.reused.map(cardHtml).join(''))}
        ${sectionHtml('Runs, in order', view.toRun.map(cardHtml).join(''))}
        ${view.calls ? `<p class="run-plan-dialog__calls">${escapeHtml(view.calls)}</p>` : ''}
        ${view.hasProblems ? '<p class="run-plan-dialog__note">Fix the problems shown in red before starting.</p>' : ''}
      </div>
      <div class="modal-alert-footer">
        <button type="button" class="btn btn-secondary run-plan-dialog__cancel">Cancel</button>
        <button type="button" class="btn btn-primary run-plan-dialog__start"${view.canStart ? '' : ' disabled'}>Start</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    function done(value) {
      overlay.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
      resolve(value);
    }
    function onKeyDown(event) {
      const overlays = document.querySelectorAll('.modal-overlay');
      if (event.key === 'Escape' && overlays[overlays.length - 1] === overlay) done(false);
    }
    overlay.querySelector('.run-plan-dialog__body').addEventListener('click', (event) => {
      const card = event.target.closest('.run-plan-dialog__step');
      if (!card) return;
      done(false);
      showNode(card.dataset.nodeId);
    });
    overlay.querySelector('.modal-close').addEventListener('click', () => done(false));
    overlay.querySelector('.run-plan-dialog__cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.run-plan-dialog__start').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) done(false); });
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    overlay.querySelector(view.canStart ? '.run-plan-dialog__start' : '.run-plan-dialog__cancel')?.focus();
  });
}
