function recordsById(records) {
  return new Map((records || []).map((record) => [record.id, record]));
}

function directUpstreamIds(records, record, byId) {
  const ids = new Set((record.sourceRecordIds || []).filter((id) => byId.has(id)));
  const inputs = record.inputs || {};
  if (record.kind === 'score') {
    if (byId.has(inputs.runRecordId)) ids.add(inputs.runRecordId);
    // Score records saved while a ground truth could follow a step's History also name that record.
    if (byId.has(inputs.groundTruthSourceRecordId)) ids.add(inputs.groundTruthSourceRecordId);
  }
  if (record.kind === 'review' && byId.has(inputs.scoreRecordId)) {
    ids.add(inputs.scoreRecordId);
  } else if (record.kind === 'review' && inputs.scoreSignature) {
    // Old Review records did not save a unique Score record ID. Link them to the
    // latest matching Score that existed when the Review was saved.
    const candidates = (records || []).filter((candidate) => candidate.kind === 'score'
      && candidate.signature === inputs.scoreSignature
      && (!inputs.scoreNodeId || candidate.nodeId === inputs.scoreNodeId)
      && (!record.createdAt || !candidate.createdAt || candidate.createdAt <= record.createdAt));
    const candidate = candidates.at(-1);
    if (candidate) ids.add(candidate.id);
  }
  return [...ids];
}

function directDownstreamMap(records, byId = recordsById(records)) {
  const downstream = new Map((records || []).map((record) => [record.id, []]));
  for (const record of records || []) {
    for (const upstreamId of directUpstreamIds(records, record, byId)) downstream.get(upstreamId)?.push(record.id);
  }
  return downstream;
}

/** IDs of records this record reads directly. This does not include ancestors of those inputs. */
export function directHistoryUpstreamIds(records, recordId) {
  const byId = recordsById(records);
  const record = byId.get(recordId);
  if (!record) throw new Error('History record was not found.');
  return directUpstreamIds(records, record, byId);
}

/** IDs of records that read this record directly. Descendants beyond one edge are excluded. */
export function directHistoryDownstreamIds(records, recordId) {
  const byId = recordsById(records);
  if (!byId.has(recordId)) throw new Error('History record was not found.');
  return directDownstreamMap(records, byId).get(recordId) || [];
}

/** Follow direct record edges recursively so deleting one result also deletes all descendants. */
export function dependentHistoryIds(records, rootId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  if (!byId.has(rootId)) throw new Error('History record was not found.');
  const downstream = directDownstreamMap(records, byId);
  const removed = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const childId of downstream.get(queue.shift()) || []) {
      if (!removed.has(childId)) {
        removed.add(childId);
        queue.push(childId);
      }
    }
  }
  return [...removed];
}
