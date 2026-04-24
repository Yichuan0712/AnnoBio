export const inspectNodeMeta = Object.freeze({
  name: 'inspect_node',
  description: 'Inspect one specific node for diagnostics, readiness, neighbors, and detailed configuration.',
  input_schema: {
    node_id: 'string',
  },
});
