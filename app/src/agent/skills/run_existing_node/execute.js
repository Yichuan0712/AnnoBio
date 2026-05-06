import { findWorkflowNodeById } from '../run_node_shared.js';
import { runExistingNodeMeta } from './meta.js';

function getSafeRunLabel(args = {}, runtime = {}) {
  const runNodeId = String(args?.run_node_id || args?.runNodeId || '').trim();
  const node = findWorkflowNodeById(runtime?.workflowSnapshot, runNodeId);
  return String(node?.title || runNodeId || 'run').trim() || 'run';
}

export const runExistingNodeSkill = Object.freeze({
  meta: runExistingNodeMeta,
  getProgressLabel({ args = {}, runtime = {} } = {}) {
    return `Starting run ${getSafeRunLabel(args, runtime)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const runNodeId = String(result?.runNodeId || '').trim();
    if (result?.alreadyRunning) return `Run ${runNodeId || 'node'} is already running`;
    if (result?.alreadyComplete) return `Run ${runNodeId || 'node'} is already complete`;
    if (result?.completed) return `Run ${runNodeId || 'node'} completed`;
    if (result?.started) return `Started run ${runNodeId || 'node'}`;
    return `Checked run ${runNodeId || 'node'}`;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.startRunNode !== 'function') {
      throw new Error('Run execution runtime is unavailable.');
    }
    const runNodeId = String(args?.run_node_id || args?.runNodeId || '').trim();
    if (!runNodeId) {
      throw new Error('Run node id is required.');
    }
    const started = await runtime.startRunNode({ runNodeId });
    return {
      ...started,
      runNodeId,
    };
  },
});
