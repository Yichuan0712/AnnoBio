/**
 * Running one Generate or Process step and waiting until it finishes, through the same canvas functions
 * the node windows use. Shared by the Agent's run_nodes (agent/execution/runJobs.js) and Run to here
 * (runTo.js). `env` is the canvas workspace: getCanvasState, startRunNode, stopRunNode,
 * runProcessNode, inspectNode.
 */
import { runInputContentOf, runResultsOf, nodeTitle } from './agent/canvas/workflowNodeInspector.js';

const POLL_MS = 1500;
// A stopped Run finishes the rows it already sent to the model before it reports cancelled.
const STOP_WAIT_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function waitWhile(isBusy, { signal, onTick, onStop }) {
  let stopRequested = false;
  for (;;) {
    if (signal?.aborted && !stopRequested) {
      stopRequested = true;
      await onStop();
      const deadline = Date.now() + STOP_WAIT_MS;
      while (isBusy() && Date.now() < deadline) await sleep(500);
      return 'stopped';
    }
    if (!isBusy()) return 'finished';
    onTick?.();
    await sleep(POLL_MS);
  }
}

export function currentNode(env, id) {
  return env.getCanvasState().nodes.find((n) => n.nodeId === id) || null;
}

/**
 * Starts a Generate and waits for it. `item` is { title, nodeIds: [runId] }.
 * @returns {Promise<{ status: 'completed'|'stopped', lines: string[], inspected?: true, errorRows?: number }>}
 *   `inspected` once it ran to the end (completed, or stopped by itself), with its error row count
 */
export async function executeRunStep(item, env, { signal, onStatus = () => {} } = {}) {
  const id = item.nodeIds[0];
  const started = await env.startRunNode({ runNodeId: id });
  if (started.waitRequired) {
    const outcome = await waitWhile(() => currentNode(env, id)?.runPending === true, {
      signal,
      onTick: () => {
        const node = currentNode(env, id);
        const input = runInputContentOf(node || {});
        const done = new Set(runResultsOf(node || {}).map((r) => r?.input_row_index)).size;
        onStatus(`Running "${nodeTitle(node)}": ${done}/${(input.rows || []).length} rows...`);
      },
      onStop: () => {
        onStatus('Stopping: the rows already sent to the model finish first...');
        return env.stopRunNode(id);
      },
    });
    if (outcome === 'stopped') {
      const node = currentNode(env, id);
      const done = new Set(runResultsOf(node || {}).map((r) => r?.input_row_index)).size;
      return {
        status: 'stopped',
        lines: [node?.runPending
          ? `${item.title}: stop requested; it finishes the rows already sent to the model, then stops (${done} rows done so far)`
          : `${item.title}: stopped by the user after ${done} rows; running it again continues from there`],
      };
    }
  }
  const inspection = await env.inspectNode(id);
  const d = inspection.details;
  const errors = d.errorRows ? `, ${d.errorRows} with errors` : '';
  return {
    status: d.status === 'completed' ? 'completed' : 'stopped',
    inspected: true,
    errorRows: Number(d.errorRows) || 0,
    lines: [`${item.title}: ${d.status}, ${d.inputRowsDone}/${d.inputRows} input rows${errors}`],
  };
}

/**
 * Runs a Process and waits for it. `item` is { title, nodeIds: [processId] }.
 * @returns {Promise<{ status: 'completed'|'stopped'|'failed', lines: string[] }>}
 */
export async function executeProcessStep(item, env, { signal, onStatus = () => {} } = {}) {
  onStatus(`Running ${item.title}...`);
  const id = item.nodeIds[0];
  try {
    const { outputs, cancelled } = await env.runProcessNode(id, { signal });
    const branches = Object.entries(outputs).map(([name, branch]) => `${name}: ${branch.rows.length} rows`);
    return { status: cancelled ? 'stopped' : 'completed', lines: [`${item.title}: ${branches.join('; ') || 'returned nothing'}`] };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return { status: 'stopped', lines: [`${item.title}: stopped by the user`] };
    return { status: 'failed', lines: [`${item.title} failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
