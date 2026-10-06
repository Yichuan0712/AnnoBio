/** A Dataset has one logical producer, even when a legacy snapshot edge repeats the same link. */
export function datasetProducerConflicts(canvasState) {
  const producers = new Map();
  const add = (datasetId, kind, sourceId) => {
    if (!datasetId || !sourceId) return;
    if (!producers.has(datasetId)) producers.set(datasetId, new Set());
    producers.get(datasetId).add(`${kind}:${sourceId}`);
  };
  for (const node of canvasState?.nodes || []) {
    if (node?.type === 'dataset') add(node.nodeId, 'run', node.sourceRunNodeId);
  }
  for (const edge of canvasState?.connections || []) {
    if (['process-to-dataset', 'process-to-dataset-snapshot'].includes(edge?.type)) {
      add(edge.toId, 'process', edge.fromId);
    } else if (edge?.type === 'run-to-dataset-snapshot') {
      add(edge.toId, 'run', edge.fromId);
    }
  }
  return [...producers.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([datasetId, values]) => ({ datasetId, producers: [...values] }));
}
