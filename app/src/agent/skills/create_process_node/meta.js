export const createProcessNodeMeta = Object.freeze({
  name: 'create_process_node',
  description:
    'Create a process node on the workflow canvas connected to an existing dataset node, running plain Python code with no LLM involved. ' +
    'Use "code" for a process(df) function called once on the whole dataset as a pandas DataFrame. ' +
    'The node is created with the given code but is not executed; the user runs it from the process node detail view using the Python interpreter configured in Settings.',
  input_schema: {
    source_node_id: 'string (required exact dataset node id to process)',
    name: 'string (optional process node name)',
    code: 'string (required Python source defining process(df) -> pandas.DataFrame or {branch_name: pandas.DataFrame})',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
  },
});
