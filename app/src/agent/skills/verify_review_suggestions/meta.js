export const verifyReviewSuggestionsMeta = Object.freeze({
  name: 'verify_review_suggestions',
  description: 'Verify review suggestions for an existing review node by re-running each proposed prompt edit on its targeted score rows. Suggestions that already have a saved final verify state/result are always skipped and cannot be re-verified through this skill. This helps the agent judge which prompt-improvement suggestions actually move outputs toward ground truth before deciding what to accept.',
  input_schema: {
    review_node_id: 'string (required exact review node id)',
    suggestion_ids: 'array of strings (optional exact suggestion ids to verify; defaults to all prompt-edit suggestions on the review node)',
  },
});
