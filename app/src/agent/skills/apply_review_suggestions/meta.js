export const applyReviewSuggestionsMeta = Object.freeze({
  name: 'apply_review_suggestions',
  description: 'Create a new prompt node from an existing review node by applying its current working prompt sections. This is the final step that turns the review draft into a concrete prompt node on the canvas, and it can still be used even when no suggestions were accepted, producing a new prompt node that matches the current/original prompt draft.',
  input_schema: {
    review_node_id: 'string (required exact review node id)',
    name: 'string (optional prompt node name; defaults to the upstream prompt name)',
    left: 'number (optional x position for the new prompt node)',
    top: 'number (optional y position for the new prompt node)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
