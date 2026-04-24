import { inspectNodeMeta } from './meta.js';

function resolveNodeTitle(workflowSnapshot, nodeId) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return '';
  const nodes = Array.isArray(workflowSnapshot?.nodes) ? workflowSnapshot.nodes : [];
  const match = nodes.find((node) => String(node?.id || '').trim() === normalizedNodeId);
  return String(match?.title || '').trim();
}

export const inspectNodeSkill = Object.freeze({
  meta: inspectNodeMeta,
  getProgressLabel({ args = {}, runtime = {} } = {}) {
    const nodeId = String(args?.node_id || '').trim();
    const nodeLabel = resolveNodeTitle(runtime?.workflowSnapshot, nodeId) || nodeId || 'node';
    return `Inspecting node ${nodeLabel}...`;
  },
  summarizeResult({ args = {}, result = null, runtime = {} } = {}) {
    const nodeId = String(args?.node_id || '').trim();
    const nodeLabel = resolveNodeTitle(runtime?.workflowSnapshot, nodeId) || String(result?.title || '').trim() || nodeId || 'node';
    const found = result?.found !== false;
    return found ? `Inspected ${nodeLabel}` : `Node ${nodeLabel} was not found`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    const nodeId = String(args?.node_id || '').trim();
    if (!nodeId || typeof runtime.inspectNode !== 'function') return null;
    const result = runtime.inspectNode(nodeId);
    return result && typeof result === 'object' ? result : null;
  },
});
