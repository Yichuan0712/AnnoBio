export const createScoreNodeMeta = Object.freeze({
  name: 'create_score_node',
  description: 'Create a fully configured score node on the workflow canvas for an existing run and ground-truth dataset.',
  input_schema: {
    run_node_id: 'string (required exact run node id)',
    ground_truth_node_id: 'string (required exact dataset node id used as ground truth)',
    score_mapping: 'object (required v2 score mapping bundle with input/output rule trees)',
    review_credential_id: 'string (optional exact review credential id for downstream review)',
    name: 'string (optional score node name)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
  },
});
