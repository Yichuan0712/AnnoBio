export const runExistingNodeMeta = Object.freeze({
  name: 'run_existing_node',
  description: 'Start an existing configured run node on the workflow canvas and wait for completion before the agent continues planning.',
  input_schema: {
    run_node_id: 'string (required exact run node id)',
  },
});
