import { buildProcessNodeSpec, summarizeProcessNodeSpec } from '../process_node_shared.js';
import { createProcessNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Process';
}

export const createProcessNodeSkill = Object.freeze({
  meta: createProcessNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating process node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Process';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created process node ${name}` : `Prepared process node ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addProcessNode !== 'function') {
      throw new Error('Process node creation runtime is unavailable.');
    }
    const processNode = buildProcessNodeSpec(args);
    const created = runtime.addProcessNode(processNode);
    return {
      ...created,
      processNode,
      summary: summarizeProcessNodeSpec(processNode),
    };
  },
});
