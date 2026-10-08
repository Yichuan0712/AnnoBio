/**
 * A Prompt or Dataset that has produced a result is locked: editing it would leave History results that
 * no longer match the inputs they were made from. Edit a Duplicate or a new version instead. A Process's
 * own code stays editable; History records each run with the code it used.
 */

/**
 * The nodes one History record used. Record inputs never change, so callers may cache this per record ID.
 * A step's output it read locks nothing: that output is the upstream record, which cannot change.
 */
export function recordInputRefs(record) {
  const inputs = record?.inputs || {};
  const ref = { kind: record?.kind || '', nodeId: String(record?.nodeId || ''), promptId: '', datasetIds: [], scoreNodeId: '' };
  const datasetIds = (items) => items.filter((item) => item?.nodeId && item.kind !== 'step').map((item) => String(item.nodeId));
  if (ref.kind === 'run') {
    ref.promptId = String(inputs.prompt?.nodeId || '');
    ref.datasetIds = datasetIds([inputs.dataset]);
  } else if (ref.kind === 'process') {
    ref.datasetIds = datasetIds(Array.isArray(inputs.bindings) ? inputs.bindings : []);
  } else if (ref.kind === 'score') {
    ref.datasetIds = [inputs.groundTruthId].filter(Boolean).map(String);
  } else if (ref.kind === 'review') {
    ref.scoreNodeId = String(inputs.scoreNodeId || '');
  }
  return ref;
}

/**
 * @param {ReturnType<typeof recordInputRefs>[]} refs one per History record
 * @param {{ nodes?: object[], connections?: object[] }} canvasState
 * @returns {Map<string, string[]>} locked node ID → IDs of the Run / Process / Score nodes whose results used it.
 *   Records of nodes no longer on the canvas do not lock anything.
 */
export function contentLocks(refs, canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const onCanvas = new Map(nodes.map((node) => [String(node.nodeId || ''), node]));
  const locks = new Map();
  const lock = (id, by) => {
    if (!id || !onCanvas.has(id) || !onCanvas.has(by)) return;
    if (!locks.has(id)) locks.set(id, []);
    if (!locks.get(id).includes(by)) locks.get(id).push(by);
  };
  const reviewedScoreIds = new Set();
  for (const ref of refs || []) {
    if (!ref) continue;
    if (ref.kind === 'run') lock(ref.promptId, ref.nodeId);
    if (['run', 'process', 'score'].includes(ref.kind)) ref.datasetIds.forEach((id) => lock(id, ref.nodeId));
    if (ref.kind === 'review') reviewedScoreIds.add(ref.scoreNodeId);
  }
  // Score metrics are computed live rather than saved, so a ground truth is in use while its Score shows
  // a result (the upstream Run has a current result) or has been reviewed.
  for (const node of nodes) {
    if (node.type !== 'score' || !node.scoreGroundTruthId) continue;
    const runId = connections.find((edge) => edge.type === 'run-to-score' && edge.toId === node.nodeId)?.fromId;
    if (reviewedScoreIds.has(node.nodeId) || onCanvas.get(runId)?.historyRecordId) lock(String(node.scoreGroundTruthId), node.nodeId);
  }
  return locks;
}
