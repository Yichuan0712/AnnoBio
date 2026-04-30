import { buildSyntheticDatasetSpec, summarizeSyntheticDatasetSpec } from '../dataset_node_shared.js';
import { createSyntheticDatasetNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Synthetic Dataset';
}

export const createSyntheticDatasetNodeSkill = Object.freeze({
  meta: createSyntheticDatasetNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating synthetic dataset ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Synthetic Dataset';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created synthetic dataset ${name}` : `Prepared synthetic dataset ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addDatasetNode !== 'function') {
      throw new Error('Dataset node creation runtime is unavailable.');
    }
    const datasetNode = buildSyntheticDatasetSpec(args);
    const created = runtime.addDatasetNode(datasetNode);
    return {
      ...created,
      datasetNode,
      summary: summarizeSyntheticDatasetSpec(datasetNode),
    };
  },
});
