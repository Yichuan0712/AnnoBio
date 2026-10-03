/** Return upstream Dataset IDs in color priority order, plus the selected Prompt. */
export function dependencyColorSources(node, nodeById, connections = []) {
  if (!node?.dataset) return { datasetIds: [], promptId: '' };
  const nodeId = node.dataset.nodeId || '';
  const source = (toId, type) => connections.find((edge) => edge.toId === toId && edge.type === type)?.fromId || '';
  const sources = (toId, type) => connections
    .filter((edge) => edge.toId === toId && edge.type === type)
    .map((edge) => edge.fromId);
  const uniqueIds = (ids) => [...new Set(ids.filter(Boolean))];
  const runSources = (runId) => {
    const run = nodeById.get(runId);
    if (!run?.dataset) return { datasetIds: [], promptId: '' };
    return {
      datasetIds: uniqueIds([run.dataset.runWorkingSetId || source(runId, 'dataset-to-run')]),
      promptId: source(runId, 'prompt-to-run'),
    };
  };

  switch (node.dataset.nodeType) {
    case 'sampler':
      return { datasetIds: uniqueIds([node.dataset.sourceNodeId || source(nodeId, 'dataset-to-sampler')]), promptId: '' };
    case 'process':
      return {
        datasetIds: uniqueIds([node.dataset.processPrimaryDatasetId, ...sources(nodeId, 'dataset-to-process')]),
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
