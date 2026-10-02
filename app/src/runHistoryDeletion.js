/** Follow the frozen record references so removing one result also removes dependent results. */
export function dependentHistoryIds(records, rootId) {
  const byId = new Map(records.map((record) => [record.id, record]));
  if (!byId.has(rootId)) throw new Error('History record was not found.');
  const removed = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    const removedScores = [...removed].map((id) => byId.get(id)).filter((record) => record?.kind === 'score');
    for (const record of records) {
      if (removed.has(record.id)) continue;
      const inputs = record.inputs || {};
      const depends = (record.sourceRecordIds || []).some((id) => removed.has(id))
        || (record.kind === 'score' && (removed.has(inputs.runRecordId) || removed.has(inputs.groundTruthSourceRecordId)))
        || (record.kind === 'review' && removedScores.some((score) => score.signature === inputs.scoreSignature
          && (!inputs.scoreNodeId || score.nodeId === inputs.scoreNodeId)));
      if (depends) { removed.add(record.id); changed = true; }
    }
  }
  return [...removed];
}
