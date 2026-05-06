import { saveRunResultsToWorkspaceMeta } from './meta.js';

function safeLabel(args = {}) {
  const name = String(args?.name || '').trim();
  const runNodeId = String(args?.run_node_id || args?.runNodeId || '').trim();
  return name || runNodeId || 'run results';
}

export const saveRunResultsToWorkspaceSkill = Object.freeze({
  meta: saveRunResultsToWorkspaceMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Saving run results ${safeLabel(args)} to workspace...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Dataset';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Saved run results to workspace dataset ${name}` : `Prepared workspace dataset ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.saveRunResultsToWorkspace !== 'function') {
      throw new Error('Run-results export runtime is unavailable.');
    }
    const runNodeId = String(args?.run_node_id || args?.runNodeId || '').trim();
    if (!runNodeId) {
      throw new Error('Run node id is required.');
    }
    return runtime.saveRunResultsToWorkspace({
      runNodeId,
      name: args?.name,
      notes: args?.notes,
      left: Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined,
      top: Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined,
      ensureUniqueName: typeof args?.ensure_unique_name === 'boolean' ? args.ensure_unique_name : true,
    });
  },
});
