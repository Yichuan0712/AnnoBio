import { buildPromptNodeSpec, summarizePromptNodeSpec } from '../prompt_node_shared.js';
import { createPromptNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Prompt';
}

export const createPromptNodeSkill = Object.freeze({
  meta: createPromptNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating prompt node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Prompt';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created prompt node ${name}` : `Prepared prompt node ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addPromptNode !== 'function') {
      throw new Error('Prompt node creation runtime is unavailable.');
    }
    const promptNode = buildPromptNodeSpec(args);
    const created = runtime.addPromptNode(promptNode);
    return {
      ...created,
      promptNode,
      summary: summarizePromptNodeSpec(promptNode),
    };
  },
});
