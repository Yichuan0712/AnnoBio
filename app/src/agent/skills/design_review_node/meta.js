export const designReviewNodeMeta = Object.freeze({
  name: 'design_review_node',
  description: 'Validate and normalize a review-node draft for an existing score node before creating and starting review on the canvas.',
  input_schema: {
    score_node_id: 'string (required exact score node id)',
    review_credential_id: 'string (optional exact review credential id; if omitted, the score node or project default may be used later)',
    name: 'string (optional review node name)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
