import { buildSyntheticDatasetSpec, summarizeSyntheticDatasetSpec } from '../dataset_node_shared.js';
import { designSyntheticDatasetMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Synthetic Dataset';
}

export const designSyntheticDatasetSkill = Object.freeze({
  meta: designSyntheticDatasetMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Designing synthetic dataset ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const spec = result?.datasetNode && typeof result.datasetNode === 'object' ? result.datasetNode : result;
    const summary = summarizeSyntheticDatasetSpec(spec);
    return `Prepared synthetic dataset draft ${summary.name} (${summary.rowCount} rows, ${summary.headerCount} columns)`;
  },
  execute({ args = {} } = {}) {
    const datasetNode = buildSyntheticDatasetSpec(args);
    return {
      drafted: true,
      datasetNode,
      summary: summarizeSyntheticDatasetSpec(datasetNode),
    };
  },
});
