import { addPromptVersionMeta } from './meta.js';

function safeLabel(args = {}) {
  const name = String(args?.name || '').trim();
  const promptNodeId = String(args?.prompt_node_id || args?.promptNodeId || '').trim();
  return name || promptNodeId || 'prompt version';
}

export const addPromptVersionSkill = Object.freeze({
  meta: addPromptVersionMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating prompt version ${safeLabel(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Prompt';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created prompt version ${name}` : `Prepared prompt version ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addPromptVersion !== 'function') {
      throw new Error('Prompt version runtime is unavailable.');
    }
    const promptNodeId = String(args?.prompt_node_id || args?.promptNodeId || '').trim();
    if (!promptNodeId) {
      throw new Error('Prompt node id is required.');
    }
    return runtime.addPromptVersion({
      promptNodeId,
      name: args?.name,
      note: args?.note,
      sections: Array.isArray(args?.sections) ? args.sections : undefined,
      outputFormat: args?.outputFormat && typeof args.outputFormat === 'object' ? args.outputFormat : undefined,
      left: Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined,
      top: Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined,
      ensureUniqueName: typeof args?.ensure_unique_name === 'boolean' ? args.ensure_unique_name : true,
    });
  },
});
