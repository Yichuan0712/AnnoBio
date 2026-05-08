import { updateScoreNodeMeta } from './meta.js';

function safeLabel(args = {}) {
  const id = String(args?.score_node_id || args?.scoreNodeId || '').trim();
  return id || 'score node';
}

function describeEdits(args = {}) {
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  if (edits.length === 0) return 'no edits';
  const counts = new Map();
  for (const edit of edits) {
    const op = String(edit?.op || 'unknown');
    counts.set(op, (counts.get(op) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([op, count]) => `${op} x${count}`).join(', ');
}

export const updateScoreNodeSkill = Object.freeze({
  meta: updateScoreNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Updating score node ${safeLabel(args)} (${describeEdits(args)})...`;
  },
  summarizeResult({ result = null } = {}) {
    if (!result || result.updated !== true) return 'Score node update did not complete';
    const ruleCount = Number.isFinite(Number(result?.ruleCount)) ? Number(result.ruleCount) : 0;
    const editsApplied = Number.isFinite(Number(result?.editsApplied)) ? Number(result.editsApplied) : 0;
    const invalidatedReviewIds = Array.isArray(result?.invalidated?.downstreamReviewNodeIds)
      ? result.invalidated.downstreamReviewNodeIds
      : [];
    const warnings = Array.isArray(result?.editWarnings) ? result.editWarnings : [];
    const parts = [];
    parts.push(`Updated score node (applied ${editsApplied} edit op${editsApplied === 1 ? '' : 's'}, ${ruleCount} rule${ruleCount === 1 ? '' : 's'} total)`);
    if (invalidatedReviewIds.length > 0) {
      parts.push(`invalidated downstream review${invalidatedReviewIds.length === 1 ? '' : 's'} (${invalidatedReviewIds.length}): rerun required`);
    } else if (result?.invalidated?.scoreComparisonRows) {
      parts.push('cleared stale comparison rows on this score');
    }
    if (warnings.length > 0) parts.push(`warnings: ${warnings.join('; ')}`);
    return parts.join(' — ');
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.updateScoreNode !== 'function') {
      throw new Error('Score node update runtime is unavailable.');
    }
    const scoreNodeId = String(args?.score_node_id || args?.scoreNodeId || '').trim();
    if (!scoreNodeId) {
      throw new Error('Score node id is required.');
    }
    const edits = Array.isArray(args?.edits) ? args.edits : [];
    return runtime.updateScoreNode({
      scoreNodeId,
      edits,
    });
  },
});
