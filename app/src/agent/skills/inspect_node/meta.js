export const inspectNodeMeta = Object.freeze({
  name: 'inspect_node',
  description: 'Inspect one specific node for diagnostics, readiness, neighbors, and detailed configuration.',
  input_schema: {
    node_id: 'string (required exact workflow node id)',
    start_row: 'integer (optional, 1-based first row to inspect for dataset/run nodes)',
    max_rows: 'integer (optional, maximum number of rows to return for dataset/run nodes)',
  },
});
