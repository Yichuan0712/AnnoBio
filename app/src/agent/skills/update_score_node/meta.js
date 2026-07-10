export const updateScoreNodeMeta = Object.freeze({
  name: 'update_score_node',
  description: [
    'Surgically update an EXISTING score node that the agent created: either its "Match by rules" rule tree, or its "Match by code" Python predicate / active mode.',
    'Use this when an agent-created score node has a wrong rule (e.g. missing match flag, wrong gtColumns, redundant input rule) or needs its match code replaced or its active mode switched. Do NOT use this on score nodes the user created — those are not editable by the agent and you must ask the user to fix them in the score detail UI.',
    'Changes are expressed as a list of small ops in `edits`; you cannot replace the whole rule mapping in one op, but set_match_code replaces the whole match code (there is no surgical code edit).',
    'Side effects: this skill only updates scoreMapping / match code / active mode. It does not clear reviewResult on the score node or on any prompt-review node, and does not clear a previously completed Match-by-code run. Rerun score/review (or the Match by code run) in the UI when you need evaluation data that strictly reflects the change.',
    'Strict locator for rule ops: each rule is identified by (tree, outputKey, gtColumns) and must match exactly one rule. If you get old_text_ambiguous-style errors with match_count >= 2, refine gtColumns until the rule is unique.',
  ].join('\n'),
  input_schema: {
    score_node_id: 'string (required exact score node id; the node must have nodeOrigin="agent")',
    edits: [
      {
        op: 'string (required: one of add_rule | remove_rule | modify_rule | set_match_code | set_match_mode)',
        tree: 'string (add_rule / remove_rule / modify_rule: "input" or "output"; "input" rules compare run input columns / row index against ground truth, "output" rules compare model output fields against ground truth)',
        // add_rule fields
        outputKey: 'string (add_rule: the output rule key; for input-side rules use bracketed run input column like "[PMID]" or "#" for row index; for output-side rules use the model output field key)',
        gtColumns: ['string (add_rule / remove_rule: list of ground-truth column names this rule maps to)'],
        matchType: 'string (add_rule / modify_rule: one of exact | abs | rel | decimals; defaults to "exact")',
        matchFlags: {
          ignoreCase: 'boolean',
          ignoreSymbols: 'boolean',
          ignoreWhitespace: 'boolean',
          contains: 'boolean (substring containment)',
          embeddingSimilarity: 'boolean (semantic similarity via embeddings)',
          semanticAlign: 'boolean (semantic alignment; mutually exclusive with embeddingSimilarity)',
          numericMode: 'string ("exact" | "abs" | "rel" | "decimals")',
          numericAbsEpsilon: 'number',
          numericRelEpsilon: 'number',
          numericDecimalPlaces: 'integer',
        },
        after: {
          outputKey: 'string (add_rule optional: anchor a new rule directly after this existing rule in the same parent group; defaults to appending at the tree root)',
          gtColumns: ['string (add_rule optional: anchor rule\'s gtColumns for unique matching)'],
        },
        // modify_rule fields
        match: {
          outputKey: 'string (modify_rule: target rule\'s current outputKey)',
          gtColumns: ['string (modify_rule: target rule\'s current gtColumns)'],
        },
        set: {
          outputKey: 'string (modify_rule optional: rename the rule\'s outputKey)',
          gtColumns: ['string (modify_rule optional: full replacement of gtColumns list)'],
          matchType: 'string (modify_rule optional)',
          matchFlags: 'object (modify_rule optional: full replacement of matchFlags object)',
        },
        // set_match_code fields
        code: 'string (set_match_code: full replacement Python source defining match(input_row, output_row, gt_row); also switches active mode to "code")',
        // set_match_mode fields
        mode: 'string (set_match_mode: "rules" or "code"; switches which saved mode is active without touching its content. Switching to "rules" is refused if the node has no usable rules.)',
      },
    ],
  },
});
