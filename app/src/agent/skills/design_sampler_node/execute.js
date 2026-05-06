import { buildSamplerNodeSpec, summarizeSamplerNodeSpec } from '../sampler_node_shared.js';
import { designSamplerNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Sample';
}

export const designSamplerNodeSkill = Object.freeze({
  meta: designSamplerNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Designing sampler node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const spec = result?.samplerNode && typeof result.samplerNode === 'object' ? result.samplerNode : result;
    const summary = summarizeSamplerNodeSpec(spec);
    return `Prepared sampler draft ${summary.name} (${summary.modeSummary})`;
  },
  execute({ args = {} } = {}) {
    const samplerNode = buildSamplerNodeSpec(args);
    return {
      drafted: true,
      samplerNode,
      summary: summarizeSamplerNodeSpec(samplerNode),
    };
  },
});
