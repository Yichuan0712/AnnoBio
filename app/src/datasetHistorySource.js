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

/**
 * The saved copy a Pipeline run published of one of its History inputs, if it is on the canvas.
 *
 * Runs made before every Process input moved onto its copy recorded some inputs under the original
 * Dataset instead. Restoring such a record and listing it in History both name the copy.
 *
 * @param {object} canvasState canvas-state nodes and connections
 * @param {object} dataset a record's input snapshot (a Run's Dataset or a Process binding)
 * @param {object|null} sourceRecord the History record that produced it
 * @returns {object|null} canvas-state Dataset node
 */
export function publishedPipelineCopy(canvasState, dataset, sourceRecord) {
  const upstreamRecordId = String(sourceRecord?.id || '');
  if (!dataset?.upstreamPipelineRecordId || !upstreamRecordId) return null;
  const nodes = canvasState?.nodes || [];
  const connections = canvasState?.connections || [];
  const nodeId = (node) => String(node?.nodeId || node?.id || '');
  const existing = nodes.find((node) => nodeId(node) === String(dataset.nodeId));
  if (existing?.savedCopy && String(existing.snapshotSourceRecordId || '') === upstreamRecordId) return existing;
  const branch = String(dataset.branch || 'result');
  const candidates = nodes.filter((node) => {
    if (node.type !== 'dataset' || !node.savedCopy || String(node.snapshotSourceRecordId || '') !== upstreamRecordId) return false;
    if (sourceRecord.pipelineRunId && node.pipelineRunId && node.pipelineRunId !== sourceRecord.pipelineRunId) return false;
    const id = nodeId(node);
    if (sourceRecord.kind === 'run') {
      return String(node.sourceRunNodeId || '') === sourceRecord.nodeId
        || connections.some((edge) => edge.type === 'run-to-dataset-snapshot'
          && edge.fromId === sourceRecord.nodeId && edge.toId === id);
    }
    return String(node.processOutputName || 'result') === branch
      && connections.some((edge) => ['process-to-dataset', 'process-to-dataset-snapshot'].includes(edge.type)
        && edge.fromId === sourceRecord.nodeId && edge.toId === id);
  });
  return candidates.find((node) => sourceRecord.pipelineRunId && node.pipelineRunId === sourceRecord.pipelineRunId)
    || candidates[0] || null;
}
