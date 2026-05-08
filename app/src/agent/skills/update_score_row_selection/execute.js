import { updateScoreRowSelectionMeta } from './meta.js';

function normalizeId(value) {
  return String(value || '').trim();
}

function collectPeerRowSelectionHints(snapshot, currentScoreId) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const nid = normalizeId(currentScoreId);
  const self = nodes.find((n) => normalizeId(n?.id) === nid);
  const gt = String(self?.config?.scoreGroundTruthId || '').trim();
  if (!gt) return [];
  return nodes
    .filter((n) => n?.type === 'score'
      && normalizeId(n?.id) !== nid
      && String(n?.config?.scoreGroundTruthId || '').trim() === gt)
    .map((n) => ({
      score_node_id: n.id,
      title: String(n?.title || '').trim(),
      scoreRowExcludedFromScoring: n.config?.scoreRowExcludedFromScoring ?? null,
    }));
}

function safeLabel(args = {}) {
  return normalizeId(args?.score_node_id || args?.scoreNodeId) || 'score node';
}

export const updateScoreRowSelectionSkill = Object.freeze({
  meta: updateScoreRowSelectionMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Updating score row selection ${safeLabel(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    if (!result || result.updated !== true) return 'Score row selection did not complete';
    const nEx = Number.isFinite(Number(result?.excludedRowKeyCount)) ? Number(result.excludedRowKeyCount) : 0;
    const nRows = Number.isFinite(Number(result?.comparison_row_count_included))
      ? Number(result.comparison_row_count_included)
      : null;
    const invalid = Array.isArray(result?.invalid_row_keys) ? result.invalid_row_keys : [];
    const parts = [];
    parts.push(`Updated row selection (${nEx} excluded key${nEx === 1 ? '' : 's'})`);
    if (nRows != null) parts.push(`${nRows} comparison row${nRows === 1 ? '' : 's'} included for metrics/Review`);
    if (invalid.length > 0) parts.push(`invalid keys: ${invalid.join(', ')} — ask user if needed`);
    return parts.join(' — ');
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.updateScoreRowSelection !== 'function') {
      throw new Error('update_score_row_selection runtime is unavailable.');
    }
    const scoreNodeId = normalizeId(args?.score_node_id || args?.scoreNodeId);
    if (!scoreNodeId) {
      throw new Error('Score node id is required.');
    }
    const exclude_row_keys = Array.isArray(args?.exclude_row_keys)
      ? args.exclude_row_keys
      : (Array.isArray(args?.excludeRowKeys) ? args.excludeRowKeys : []);
    const include_row_keys = Array.isArray(args?.include_row_keys)
      ? args.include_row_keys
      : (Array.isArray(args?.includeRowKeys) ? args.includeRowKeys : []);

    const out = await runtime.updateScoreRowSelection({
      scoreNodeId,
      exclude_row_keys,
      include_row_keys,
    });
    const peer_scores_same_gt = collectPeerRowSelectionHints(runtime?.workflowSnapshot, scoreNodeId);
    return { ...out, peer_scores_same_gt };
  },
});
