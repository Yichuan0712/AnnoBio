export const createProcessNodeMeta = Object.freeze({
  name: 'create_process_node',
  description:
    'Create a process node on the workflow canvas connected to an existing dataset node, running plain Python code with no LLM involved. ' +
    'Use "code" for a process(row) function called once per row, or "df_code" for a process(df) function called once on the whole dataset as a pandas DataFrame. ' +
    'The node is created with the given code but is not executed; the user runs it from the process node detail view using the Python interpreter configured in Settings.',
  input_schema: {
    source_node_id: 'string (required exact dataset node id to process)',
    name: 'string (optional process node name)',
    code: 'string (optional Python source defining process(row) -> dict | None; required unless df_code is given)',
    df_code: 'string (optional Python source defining process(df) -> DataFrame; required unless code is given)',
    active_mode: 'string (optional: "row" or "df"; defaults to whichever of code/df_code was given)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
  },
});
