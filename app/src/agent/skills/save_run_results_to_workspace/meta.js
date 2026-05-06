export const saveRunResultsToWorkspaceMeta = Object.freeze({
  name: 'save_run_results_to_workspace',
  description: 'Save the current results of an existing run node to the workspace as a dataset node, matching the Run panel "Save to workspace" behavior.',
  input_schema: {
    run_node_id: 'string (required exact run node id)',
    name: 'string (optional dataset node name; defaults to prompt-name + run-name export naming)',
    notes: 'string (optional dataset description; defaults to run export summary)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true when a custom name is provided)',
  },
});
