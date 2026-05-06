import { buildSamplerNodeSpec, summarizeSamplerNodeSpec } from '../sampler_node_shared.js';
import { createSamplerNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Sample';
}

export const createSamplerNodeSkill = Object.freeze({
  meta: createSamplerNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating sampler node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Sample';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created sampler node ${name}` : `Prepared sampler node ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addSamplerNode !== 'function') {
      throw new Error('Sampler node creation runtime is unavailable.');
    }
    const samplerNode = buildSamplerNodeSpec(args);
    const created = runtime.addSamplerNode(samplerNode);
    return {
      ...created,
      samplerNode,
      summary: summarizeSamplerNodeSpec(samplerNode),
    };
  },
});
