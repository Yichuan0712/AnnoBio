/**
 * Run to here (docs/design/RUN_TO_HERE_PLAN.md step 2): runs a plan from runPlan.js one step after
 * another, through the same single-step functions the node windows use, so every result lands in
 * its node's History as usual. Nothing about the task is saved: running it again plans again, which
 * reuses the finished steps and continues a Run stopped part way.
 */
import { planRunTo } from './runPlan.js';
import { executeProcessStep, executeRunStep } from './stepExecution.js';
import { holdNodes, isTaskLocked } from './runTaskLocks.js';

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();

/** What the task holds: every step, the Prompt of each Run and every Dataset read. */
export function planHeldNodeIds(state, plan) {
  const ids = new Set(plan.steps.map((step) => step.nodeId));
  for (const step of plan.steps) {
    if (step.kind !== 'run') continue;
    const edge = (state?.connections || []).find((item) => item?.type === 'prompt-to-run' && String(item.toId) === step.nodeId);
    if (edge) ids.add(String(edge.fromId));
  }
  for (const input of plan.inputs) ids.add(input.nodeId);
  return [...ids];
}

/** Whether two plans would do the same: the same steps, each reused or run alike. */
export function samePlanSteps(a, b) {
  const shape = (plan) => JSON.stringify((plan?.steps || []).map((step) => [step.nodeId, step.action]));
  return shape(a) === shape(b);
}

/**
 * @param {string} targetId
 * @param {object} env the canvas workspace (stepExecution.js)
 * @param {{ context: { settings?: object, credentialIds?: Set<string> }, planOptions?: object, signal?: AbortSignal,
 *   approvedPlan?: object, onStep?: (step: object, task: object) => void }} options planOptions: as for
 *   planRunTo (Execute this step, run again)
 *   approvedPlan: the plan the user confirmed; the run is refused when the canvas now plans otherwise
 * @returns {Promise<{ status: 'completed'|'failed'|'stopped', error?: string, plan: object,
 *   steps: Array<{ nodeId, name, kind, action, status: 'reused'|'pending'|'running'|'completed'|'failed'|'stopped'|'not-started',
 *     recordId?: string, errorRows?: number, message?: string }> }>}
 */
export async function runTo(targetId, env, { context = {}, planOptions = {}, signal, approvedPlan, onStep = () => {} } = {}) {
  const state = env.getCanvasState();
  const plan = planRunTo(state, targetId, context, planOptions);
  const task = {
    status: 'completed',
    plan,
    steps: plan.steps.map(({ nodeId, name, kind, action }) => ({
      nodeId, name, kind, action, status: action === 'reuse' ? 'reused' : 'pending',
    })),
  };
  const refuse = (error) => ({ ...task, status: 'failed', error });
  if (approvedPlan && !samePlanSteps(approvedPlan, plan)) return refuse('The canvas changed after the plan was shown. Check the plan again.');
  if (plan.problems.length) return refuse(plan.problems.map((problem) => problem.message).join(' '));
  if (!plan.toRun) return task;

  const heldIds = planHeldNodeIds(state, plan);
  if (heldIds.some((id) => isTaskLocked(id))) return refuse('Part of this plan is already in another run in progress.');
  const release = holdNodes(heldIds);
  try {
    for (const step of task.steps) {
      if (step.status !== 'pending') continue;
      if (signal?.aborted) {
        task.status = 'stopped';
        break;
      }
      // What the step reads must be there now: its upstream steps in this plan have finished.
      const ready = planRunTo(env.getCanvasState(), step.nodeId, context, { onlyThis: true });
      const blocker = ready.problems[0]?.message || '';
      if (blocker) {
        Object.assign(step, { status: 'failed', message: blocker });
        task.status = 'failed';
        onStep(step, task);
        break;
      }
      step.status = 'running';
      onStep(step, task);
      const item = { title: `"${step.name}"`, nodeIds: [step.nodeId] };
      let outcome;
      try {
        outcome = step.kind === 'run'
          ? await executeRunStep(item, env, { signal })
          : await executeProcessStep(item, env, { signal });
      } catch (error) {
        outcome = { status: 'failed', lines: [`"${step.name}": ${error instanceof Error ? error.message : String(error)}`] };
      }
      // A Run that ends short (stopped from its window, or interrupted) continues when run again.
      const status = outcome.status === 'completed' ? 'completed'
        : outcome.status === 'failed' ? 'failed' : 'stopped';
      const node = env.getCanvasState().nodes.find((entry) => nodeIdOf(entry) === step.nodeId);
      Object.assign(step, {
        status,
        message: outcome.lines.join(' '),
        ...(node?.historyRecordId ? { recordId: node.historyRecordId } : {}),
        ...(outcome.errorRows ? { errorRows: outcome.errorRows } : {}),
      });
      onStep(step, task);
      if (status !== 'completed') {
        task.status = status;
        break;
      }
    }
  } finally {
    release();
  }
  for (const step of task.steps) if (step.status === 'pending') step.status = 'not-started';
  return task;
}
