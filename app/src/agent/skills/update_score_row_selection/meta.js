export const updateScoreRowSelectionMeta = Object.freeze({
  name: 'update_score_row_selection',
  description: [
    'Set which score-table rows are included in Review and in Precision / Recall / F1 (same as the Score detail checkboxes). Only score nodes created by the agent (nodeOrigin="agent") can be updated by this skill; otherwise ask the user to toggle rows in the Score UI.',
    'Row keys must match the canvas: for paired rows use the ground-truth row index as a string ("0", "1", …); for run-only rows use "run:<run_row_index>" (e.g. "run:3").',
    'Before choosing keys, inspect this score (`inspect_node`) for comparison row fields (`source_gt_row_index`, `row_index`, `gt_only`). If this score uses a GT dataset that another score on the canvas also uses, inspect those peer score nodes: `config.scoreRowExcludedFromScoring` shows how rows were excluded elsewhere.',
    'If pairing or which key to use is unclear, or `invalid_row_keys` is non-empty after a call, stop and ask the user which rows should be included.',
    'After success, call `inspect_node` on the same score to read refreshed `details.metrics`. `create_and_run_review_node` sends only comparison rows for included (non-excluded) lines.',
  ].join('\n'),
  input_schema: {
    score_node_id: 'string (required exact score node id; must be agent-created)',
    exclude_row_keys: [
      'string (keys to EXCLUDE from Review + metrics; sets excluded[key]=true)',
    ],
    include_row_keys: [
      'string (keys to INCLUDE; removes key from the exclusion map)',
    ],
  },
});
