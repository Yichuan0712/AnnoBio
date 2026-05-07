export const createAndRunReviewNodeMeta = Object.freeze({
  name: 'create_and_run_review_node',
  description: 'Create a review node for an existing score node and immediately start prompt-optimization review. Review nodes use score results to produce suggestions for improving the upstream prompt and preparing a revised prompt draft.',
  input_schema: {
    score_node_id: 'string (required exact score node id)',
    review_credential_id: 'string (optional exact review credential id; if omitted, the score node or project default may be used)',
    name: 'string (optional review node name)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
