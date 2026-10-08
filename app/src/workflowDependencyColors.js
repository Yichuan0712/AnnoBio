import { processInputSources, processPrimarySource, runInputSource } from './stepInputs.js';

/**
 * Return upstream Dataset IDs in color priority order, plus the selected Prompt. A step that reads
 * another step's output is colored by the Datasets that step reads, further up.
 */
export function dependencyColorSources(node, nodeById, connections = [], visited = new Set()) {
  if (!node?.dataset) return { datasetIds: [], promptId: '' };
  const nodeId = node.dataset.nodeId || '';
  visited.add(nodeId);
  const source = (toId, type) => connections.find((edge) => edge.toId === toId && edge.type === type)?.fromId || '';
  const uniqueIds = (ids) => [...new Set(ids.filter(Boolean))];
  const state = { nodes: [...nodeById].map(([id, item]) => ({ nodeId: id, type: item?.dataset?.nodeType })), connections };
  const upstreamDatasets = (ids) => ids.flatMap((id) => {
    const upstream = nodeById.get(id);
    if (!['run', 'process'].includes(upstream?.dataset?.nodeType)) return [id];
    if (visited.has(id)) return [];
    return dependencyColorSources(upstream, nodeById, connections, visited).datasetIds;
  });
  const runSources = (runId) => {
    const run = nodeById.get(runId);
    if (!run?.dataset) return { datasetIds: [], promptId: '' };
    return {
      datasetIds: uniqueIds(upstreamDatasets([runInputSource(state, runId)?.nodeId])),
      promptId: source(runId, 'prompt-to-run'),
    };
  };

  switch (node.dataset.nodeType) {
    case 'sampler':
      return { datasetIds: uniqueIds([node.dataset.sourceNodeId || source(nodeId, 'dataset-to-sampler')]), promptId: '' };
    case 'process':
      return {
        datasetIds: uniqueIds(upstreamDatasets([processPrimarySource(state, nodeId)?.nodeId,
          ...processInputSources(state, nodeId).map((source) => source.nodeId)])),
        promptId: '',
      };
    case 'run':
      return runSources(nodeId);
    case 'score': {
      const upstream = runSources(source(nodeId, 'run-to-score'));
      return {
        datasetIds: uniqueIds([node.dataset.scoreGroundTruthId, ...upstream.datasetIds]),
        promptId: upstream.promptId,
      };
    }
    case 'promptReview': {
      const score = nodeById.get(source(nodeId, 'score-to-prompt-review'));
      return score ? dependencyColorSources(score, nodeById, connections) : { datasetIds: [], promptId: '' };
    }
    default:
      return { datasetIds: [], promptId: '' };
  }
}

export function dependentNodeVisualColors(dataColors, promptColor = '') {
  const dataColor = dataColors.find(Boolean) || '';
  return {
    borderColor: promptColor || dataColor,
    dataColor,
  };
}
