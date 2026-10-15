/**
 * The inputs try_process runs code with: the ones a new Process reading `primaryId` would get in its
 * window (stepInputs.js processRequiredInputs), that is df and every Dataset or step output the code
 * names by its df_<alias>, each with the table it gives now (stepOutputs.js). Pure; works on
 * getCanvasState() output and does not change it.
 */
import { referencedDatasetAliasNames } from '../../processDatasetBindings.js';
import { effectiveProcessOutputs } from '../../processOutputPorts.js';
import { processInputBindings, processRequiredInputs, stepInputWaitingMessage, stepSourceLabel } from '../../stepInputs.js';
import { stepOutputTable } from '../../stepOutputs.js';

const TRIAL_ID = '__try_process__';

/**
 * @returns {Array<{ key: string, nodeId: string, port: string, kind: string, label: string, alias: string, primary: boolean, content: object }>}
 * @throws {Error} naming what is wrong, as the Process window would show it
 */
export function processTrialInputs(state, code, primaryId, primaryBranch = '') {
  const source = (state?.nodes || []).find((node) => node.nodeId === String(primaryId || '').trim());
  if (!source || !['dataset', 'run', 'process'].includes(source.type)) {
    throw new Error('primary_input must be the id of a dataset, run or process on the canvas.');
  }
  const branch = String(primaryBranch || '').trim();
  let port = 'result';
  if (source.type === 'process') {
    const { ports } = effectiveProcessOutputs({ detected: source.processOutputPorts, dfResults: source.dfResults });
    if (!ports.length) throw new Error(`Process "${source.name || 'Process'}" has no known branches yet; run it first.`);
    port = branch || (ports.length === 1 ? ports[0] : '');
    if (!port) throw new Error(`Process "${source.name || 'Process'}" has several branches (${ports.join(', ')}); name primary_branch.`);
    if (!ports.includes(port)) throw new Error(`Process "${source.name || 'Process'}" has no branch "${port}". Branches: ${ports.join(', ')}.`);
  } else if (branch && branch !== 'result') {
    throw new Error(`primary_input is a ${source.type} with one output; it has no branch "${branch}".`);
  }
  const trial = {
    ...state,
    nodes: [...state.nodes, { type: 'process', nodeId: TRIAL_ID, name: 'Process', dfCode: code }],
    connections: [...state.connections, { type: 'data', fromId: source.nodeId, fromPort: port, toId: TRIAL_ID, alias: 'df' }],
  };
  const candidates = processInputBindings(trial, TRIAL_ID, { code });
  const unknown = [...referencedDatasetAliasNames(code)].filter((alias) => !candidates.some((binding) => binding.alias === alias));
  if (unknown.length) {
    const available = candidates.filter((binding) => !binding.primary).map((binding) => `${binding.alias} ("${binding.label}")`);
    throw new Error(`Unknown input alias ${unknown.join(', ')}. Available: ${available.join(', ') || '(none)'}`);
  }
  return processRequiredInputs(trial, TRIAL_ID, { code }).bindings.map((binding) => {
    const output = stepOutputTable(trial, binding);
    if (output.waiting) throw new Error(stepInputWaitingMessage(trial, binding, output.waiting));
    return { ...binding, label: stepSourceLabel(trial, binding), content: output.table };
  });
}
