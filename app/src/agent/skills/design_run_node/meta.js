export const designRunNodeMeta = Object.freeze({
  name: 'design_run_node',
  description: 'Validate and normalize a fully configured run-node draft for an existing prompt and dataset before creating it on the canvas.',
  input_schema: {
    prompt_node_id: 'string (required exact prompt node id)',
    working_set_id: 'string (required exact dataset node id used as run input)',
    input_to_column: {
      '<prompt_input_name>': 'string (required mapped dataset column name)',
    },
    credential_id: 'string (optional exact credential id; if omitted, the run can fall back to the default run credential later)',
    name: 'string (optional run node name)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
