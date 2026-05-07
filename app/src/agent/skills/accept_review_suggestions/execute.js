import { acceptReviewSuggestionsMeta } from './meta.js';

function safeLabel(args = {}) {
  const reviewNodeId = String(args?.review_node_id || args?.reviewNodeId || '').trim();
  return reviewNodeId || 'review suggestions';
}

export const acceptReviewSuggestionsSkill = Object.freeze({
  meta: acceptReviewSuggestionsMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Accepting verified suggestions for ${safeLabel(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const reviewNodeId = String(result?.reviewNodeId || '').trim() || 'review';
    const acceptedCount = Number(result?.acceptedCount) || 0;
    const rejectedCount = Number(result?.rejectedCount) || 0;
    return `Accepted ${acceptedCount} suggestion${acceptedCount === 1 ? '' : 's'} for ${reviewNodeId}; rejected ${rejectedCount}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.acceptReviewSuggestions !== 'function') {
      throw new Error('Review acceptance runtime is unavailable.');
    }
    const reviewNodeId = String(args?.review_node_id || args?.reviewNodeId || '').trim();
    if (!reviewNodeId) {
      throw new Error('Review node id is required.');
    }
    const suggestionIds = Array.isArray(args?.suggestion_ids)
      ? args.suggestion_ids
      : (Array.isArray(args?.suggestionIds) ? args.suggestionIds : []);
    return runtime.acceptReviewSuggestions({
      reviewNodeId,
      suggestionIds,
    });
  },
});
