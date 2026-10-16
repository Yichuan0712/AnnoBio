/**
 * Executions (docs/design/RUN_TO_HERE_PLAN.md step 4): one record per Run to here, kept with the
 * project next to its History (web: backend/project_store.py run-records; desktop: the .yc
 * bundle's runRecords). A record says what was planned and how each step ended; the results
 * themselves are in each node's History.
 */
import { BACKEND_API_BASE } from './backendConfig.js';

const webStorage = {
  async loadRunRecords(projectId) {
    const res = await fetch(`${BACKEND_API_BASE}/api/projects/${encodeURIComponent(projectId)}/run-records`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.records) ? body.records : [];
  },
  async saveRunRecords(projectId, records) {
    const res = await fetch(`${BACKEND_API_BASE}/api/projects/${encodeURIComponent(projectId)}/run-records`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }),
    });
    if (!res.ok) throw new Error('Could not save the run records.');
  },
};
const storage = () => (globalThis.window?.electronAPI?.loadRunRecords ? globalThis.window.electronAPI : webStorage);

/** @param {string} projectKey desktop: the project file path; web: the project id */
export async function loadExecutionRecords(projectKey) {
  if (!projectKey) return [];
  const records = await storage().loadRunRecords(projectKey);
  return Array.isArray(records) ? records : [];
}

export async function saveExecutionRecords(projectKey, records) {
  if (!projectKey) return;
  await storage().saveRunRecords(projectKey, records);
}

/**
 * A new record for a plan about to run. Pure.
 * @param {ReturnType<import('./runPlan.js').planRunTo>} plan
 * @param {{ id: string, now: number, source?: 'user'|'agent' }} options
 */
export function newExecutionRecord(plan, { id, now, source = 'user' }) {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    source,
    targetNodeId: plan.targetId,
    targetName: plan.steps.at(-1)?.name || '',
    scope: plan.scope || 'to-here',
    status: 'running',
    inputs: plan.inputs.map(({ nodeId, name, rows }) => ({ nodeId, name, rows })),
    steps: plan.steps.map(({ nodeId, name, kind, action }) => ({
      nodeId, name, kind, action, status: action === 'reuse' ? 'reused' : 'pending',
    })),
  };
}

/** The record once `task` (runTo.js) has moved on: its steps' statuses and, when ended, its own. Pure. */
export function updateExecutionRecord(record, task, { now, ended = false }) {
  const byNode = new Map((task?.steps || []).map((step) => [step.nodeId, step]));
  return {
    ...record,
    updatedAt: now,
    status: ended ? task.status : record.status,
    ...(ended && task.error ? { error: task.error } : {}),
    steps: record.steps.map((step) => {
      const done = byNode.get(step.nodeId);
      if (!done) return step;
      const { status, recordId, errorRows, message } = done;
      return {
        ...step, status,
        ...(recordId ? { recordId } : {}),
        ...(errorRows ? { errorRows } : {}),
        ...(message && status !== 'completed' && status !== 'reused' ? { message } : {}),
      };
    }),
  };
}

/**
 * Records left 'running' when the window closed (the app quit, or the page reloaded), which no task
 * in this window owns. The step that was running is 'interrupted': on the web its job may still have
 * finished on the server, so the record does not claim either way. Running the target again picks
 * up from the current results. Pure.
 */
export function endInterruptedRecords(records, activeIds, now) {
  let changed = false;
  const next = records.map((record) => {
    if (record.status !== 'running' || activeIds.has(record.id)) return record;
    changed = true;
    return {
      ...record, status: 'stopped', updatedAt: now,
      error: 'The window closed before this run finished. The step that was running may still have finished; check its node. Resume picks up from the current results.',
      steps: record.steps.map((step) => (['pending', 'running'].includes(step.status)
        ? { ...step, status: step.status === 'running' ? 'interrupted' : 'not-started' } : step)),
    };
  });
  return { records: next, changed };
}

/** Counts for a record's summary line. Pure. */
export function executionCounts(record) {
  const count = (statuses) => record.steps.filter((step) => statuses.includes(step.status)).length;
  return {
    ran: count(['completed']),
    reused: count(['reused']),
    failed: count(['failed']),
    errorRows: record.steps.reduce((sum, step) => sum + (Number(step.errorRows) || 0), 0),
  };
}

/** "2 ran · 1 reused · 3 rows with errors". Pure. */
export function executionSummary(record) {
  const { ran, reused, failed, errorRows } = executionCounts(record);
  return [
    `${ran} ran`,
    reused ? `${reused} reused` : '',
    failed ? `${failed} failed` : '',
    errorRows ? `${errorRows} row${errorRows === 1 ? '' : 's'} with errors` : '',
  ].filter(Boolean).join(' · ');
}
