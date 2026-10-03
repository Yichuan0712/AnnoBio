/**
 * The Run / Process result whose History record a Dataset's content follows, if any.
 *
 * A saved output (`savedCopy`) keeps its "produced by" link (sourceRunNodeId or a process-to-dataset
 * edge) so pipelines still chain through it, but it is a copy: History never rewrites its content,
 * and it signs, locks and edits like any other table. Older outputs saved before copies existed have
 * no flag and still follow History until they are first edited.
 *
 * @param {object} dataset canvas-state Dataset node
 * @param {object[]} connections canvas-state connections
 * @returns {{ sourceId: string, kind: 'run'|'process', branch: string } | null}
 */
export function datasetHistorySource(dataset, connections) {
  if (!dataset || dataset.savedCopy) return null;
  const runId = String(dataset.sourceRunNodeId || '');
  if (runId) return { sourceId: runId, kind: 'run', branch: 'result' };
  const id = String(dataset.nodeId || dataset.id || '');
  const edge = (connections || []).find((item) => item?.type === 'process-to-dataset' && item.toId === id);
  return edge ? { sourceId: String(edge.fromId), kind: 'process', branch: String(dataset.processOutputName || 'result') } : null;
}
