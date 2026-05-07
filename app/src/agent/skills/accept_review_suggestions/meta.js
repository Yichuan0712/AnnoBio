export const acceptReviewSuggestionsMeta = Object.freeze({
  name: 'accept_review_suggestions',
  description: 'Decide which review suggestions to accept on an existing review node, using stored verification outcomes to conservatively apply only prompt edits that have strong evidence. This updates the review node working prompt so the accepted revisions can become the next prompt draft.',
  input_schema: {
    review_node_id: 'string (required exact review node id)',
    suggestion_ids: 'array of strings (optional exact suggestion ids to consider; defaults to all prompt-edit suggestions on the review node)',
  },
});
