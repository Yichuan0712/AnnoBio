export const createScoreNodeMeta = Object.freeze({
  name: 'create_score_node',
  description:
    'Create a fully configured score node on the workflow canvas for an existing run and ground-truth dataset. ' +
    'Supports two mutually exclusive matching modes: "Match by rules" (score_mapping, a rule tree) and "Match by code" (match_code, a Python match(input_row, output_row, gt_row) predicate with no LLM involved). ' +
    'Provide at least one of score_mapping (with at least one rule) or match_code. If match_code is given, running the code-based match happens later from the score node detail view using the Python interpreter configured in Settings; the agent has no skill to execute it or read back results.',
  input_schema: {
    run_node_id: 'string (required exact run node id)',
    ground_truth_node_id: 'string (required exact dataset node id used as ground truth)',
    score_mapping: 'object (optional v2 score mapping bundle with input/output rule trees; required unless match_code is given)',
    match_code: 'string (optional Python source defining match(input_row, output_row, gt_row) -> truthy/falsy; required unless score_mapping is given)',
    active_match_mode: 'string (optional: "rules" or "code"; defaults to "code" when match_code is given, else "rules")',
    review_credential_id: 'string (optional exact review credential id for downstream review)',
    name: 'string (optional score node name)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
  },
});
