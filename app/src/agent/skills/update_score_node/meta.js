export const updateScoreNodeMeta = Object.freeze({
  name: 'update_score_node',
  description: [
    'Surgically update the matching rules of an EXISTING score node that the agent created.',
    'Use this when an agent-created score node has a wrong rule (e.g. missing match flag, wrong gtColumns, redundant input rule). Do NOT use this on score nodes the user created — those are not editable by the agent and you must ask the user to fix them in the score detail UI.',
    'Changes are expressed as a list of small ops in `edits`; you cannot replace the whole mapping.',
    'Side effects: after a successful update, the score node\'s comparison_rows and any directly-connected promptReview node\'s reviewResult are wiped. You must rerun the score / review (e.g. via create_and_run_review_node) to regenerate evaluation data — the previous review suggestions and verifyResults no longer reflect the new mapping.',
    'Strict locator: each rule is identified by (tree, outputKey, gtColumns) and must match exactly one rule. If you get old_text_ambiguous-style errors with match_count >= 2, refine gtColumns until the rule is unique.',
  ].join('\n'),
  input_schema: {
    score_node_id: 'string (required exact score node id; the node must have nodeOrigin="agent")',
    edits: [
      {
        op: 'string (required: one of add_rule | remove_rule | modify_rule)',
        tree: 'string (required: "input" or "output"; "input" rules compare run input columns / row index against ground truth, "output" rules compare model output fields against ground truth)',
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
      },
    ],
  },
});
