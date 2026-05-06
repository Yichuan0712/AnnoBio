import { buildSampledDatasetNodeSpec, summarizeSampledDatasetNodeSpec } from '../sampled_dataset_node_shared.js';
import { createSampledDatasetNodeMeta } from './meta.js';

function safeLabel(args = {}) {
  const name = String(args?.name || '').trim();
  const samplerNodeId = String(args?.sampler_node_id || '').trim();
  return name || samplerNodeId || 'sampled dataset';
}

export const createSampledDatasetNodeSkill = Object.freeze({
  meta: createSampledDatasetNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating sampled dataset ${safeLabel(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Dataset';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created sampled dataset ${name}` : `Prepared sampled dataset ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addSampledDatasetNode !== 'function') {
      throw new Error('Sampled dataset creation runtime is unavailable.');
    }
    const sampledDatasetNode = buildSampledDatasetNodeSpec(args);
    const created = runtime.addSampledDatasetNode(sampledDatasetNode);
    return {
      ...created,
      sampledDatasetNode,
      summary: summarizeSampledDatasetNodeSpec(sampledDatasetNode),
    };
  },
});
