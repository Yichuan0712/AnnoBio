export const saveScoreResultsToWorkspaceMeta = Object.freeze({
  name: 'save_score_results_to_workspace',
  description: 'Save the current comparison-table results of an existing score node to the workspace as a dataset node, matching the Score panel "Save to workspace" behavior.',
  input_schema: {
    score_node_id: 'string (required exact score node id)',
    name: 'string (optional dataset node name; defaults to score-name + comparison export naming)',
    notes: 'string (optional dataset description; defaults to score export summary)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true when a custom name is provided)',
  },
});
