export const createRunNodeMeta = Object.freeze({
  name: 'create_run_node',
  description: 'Create a fully configured run node on the workflow canvas for an existing prompt and input dataset without executing the run.',
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
