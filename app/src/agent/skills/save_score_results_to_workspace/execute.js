import { saveScoreResultsToWorkspaceMeta } from './meta.js';

function safeLabel(args = {}) {
  const name = String(args?.name || '').trim();
  const scoreNodeId = String(args?.score_node_id || args?.scoreNodeId || '').trim();
  return name || scoreNodeId || 'score results';
}

export const saveScoreResultsToWorkspaceSkill = Object.freeze({
  meta: saveScoreResultsToWorkspaceMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Saving score results ${safeLabel(args)} to workspace...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Dataset';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Saved score results to workspace dataset ${name}` : `Prepared workspace dataset ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.saveScoreResultsToWorkspace !== 'function') {
      throw new Error('Score-results export runtime is unavailable.');
    }
    const scoreNodeId = String(args?.score_node_id || args?.scoreNodeId || '').trim();
    if (!scoreNodeId) {
      throw new Error('Score node id is required.');
    }
    return runtime.saveScoreResultsToWorkspace({
      scoreNodeId,
      name: args?.name,
      notes: args?.notes,
      left: Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined,
      top: Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined,
      ensureUniqueName: typeof args?.ensure_unique_name === 'boolean' ? args.ensure_unique_name : true,
    });
  },
});
