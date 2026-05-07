import { applyReviewSuggestionsMeta } from './meta.js';

function safeLabel(args = {}) {
  const reviewNodeId = String(args?.review_node_id || args?.reviewNodeId || '').trim();
  return reviewNodeId || 'review';
}

export const applyReviewSuggestionsSkill = Object.freeze({
  meta: applyReviewSuggestionsMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Applying accepted review changes for ${safeLabel(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Prompt';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created prompt node ${name} from review` : `Prepared prompt node ${name} from review`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.applyReviewSuggestions !== 'function') {
      throw new Error('Review apply runtime is unavailable.');
    }
    const reviewNodeId = String(args?.review_node_id || args?.reviewNodeId || '').trim();
    if (!reviewNodeId) {
      throw new Error('Review node id is required.');
    }
    return runtime.applyReviewSuggestions({
      reviewNodeId,
      name: args?.name,
      left: Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined,
      top: Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined,
      ensureUniqueName: typeof args?.ensure_unique_name === 'boolean' ? args.ensure_unique_name : true,
    });
  },
});
