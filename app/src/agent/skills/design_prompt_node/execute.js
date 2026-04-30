import { buildPromptNodeSpec, summarizePromptNodeSpec } from '../prompt_node_shared.js';
import { designPromptNodeMeta } from './meta.js';

function summarize(spec) {
  const summary = summarizePromptNodeSpec(spec);
  return `${summary.name} (${summary.sectionCount} sections, ${summary.outputFieldCount} output fields)`;
}

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Prompt';
}

export const designPromptNodeSkill = Object.freeze({
  meta: designPromptNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Designing prompt node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const spec = result?.promptNode && typeof result.promptNode === 'object' ? result.promptNode : result;
    return spec ? `Prepared prompt node draft ${summarize(spec)}` : 'Prepared prompt node draft';
  },
  execute({ args = {} } = {}) {
    const promptNode = buildPromptNodeSpec(args);
    return {
      drafted: true,
      promptNode,
      summary: summarizePromptNodeSpec(promptNode),
    };
  },
});
