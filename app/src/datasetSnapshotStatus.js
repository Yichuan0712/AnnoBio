/** A saved copy stays frozen; compare the captured History record with the producer's current one. */
export function datasetSnapshotStatus(dataset, nodes, connections) {
  if (!dataset?.savedCopy) return 'live';
  const sourceId = dataset.sourceRunNodeId || (connections || []).find((edge) => (
    ['process-to-dataset', 'process-to-dataset-snapshot', 'run-to-dataset-snapshot'].includes(edge?.type)
    && edge.toId === dataset.nodeId
  ))?.fromId;
  if (!sourceId) return 'independent';
  if (!dataset.snapshotSourceRecordId) return 'unknown';
  const source = nodes instanceof Map ? nodes.get(sourceId) : (nodes || []).find((node) => node.nodeId === sourceId);
  return source?.historyRecordId === dataset.snapshotSourceRecordId ? 'current' : 'stale';
}
