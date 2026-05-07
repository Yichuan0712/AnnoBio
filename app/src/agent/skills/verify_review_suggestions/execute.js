import { verifyReviewSuggestionsMeta } from './meta.js';

function safeLabel(args = {}) {
  const reviewNodeId = String(args?.review_node_id || args?.reviewNodeId || '').trim();
  return reviewNodeId || 'review suggestions';
}

export const verifyReviewSuggestionsSkill = Object.freeze({
  meta: verifyReviewSuggestionsMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Verifying suggestions for ${safeLabel(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const reviewNodeId = String(result?.reviewNodeId || '').trim() || 'review';
    const verifiedCount = Number(result?.verifiedCount) || 0;
    const fullyVerifiedCount = Number(result?.fullyVerifiedCount) || 0;
    return `Verified ${verifiedCount} suggestion${verifiedCount === 1 ? '' : 's'} for ${reviewNodeId}; ${fullyVerifiedCount} fully passed`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.verifyReviewSuggestions !== 'function') {
      throw new Error('Review verification runtime is unavailable.');
    }
    const reviewNodeId = String(args?.review_node_id || args?.reviewNodeId || '').trim();
    if (!reviewNodeId) {
      throw new Error('Review node id is required.');
    }
    const suggestionIds = Array.isArray(args?.suggestion_ids)
      ? args.suggestion_ids
      : (Array.isArray(args?.suggestionIds) ? args.suggestionIds : []);
    return runtime.verifyReviewSuggestions({
      reviewNodeId,
      suggestionIds,
    });
  },
});
