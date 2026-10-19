# Evaluation with Evaluate nodes

String Match options include HGNC (human genes), PubChem (compounds), and Ontology with GO,
ChEBI or MONDO, alongside RxNorm, MeSH and Semantic. HGNC/PubChem/Ontology compare uniquely
resolved standard IDs, not search rankings. Ambiguous names do not match; a service failure
fails the evaluation and must not be explained as an extraction error. HGNC is human-only;
PubChem preserves distinct CIDs (including different salts/stereoisomers).
For flat proposals use match: {hgnc: true}, {pubchem: true}, or {ontology: "go" | "chebi" | "mondo"}.
For rule_tree use hgncMatch/pubchemMatch/ontologyMatch booleans and ontologySource in matchFlags.
Rules execution reports actual lookup and comparison progress. Results and metrics appear together
only after the complete attempt succeeds; the prior completed evaluation remains visible meanwhile.

## What an Evaluate node needs

- An upstream Generate with results.
- A ground-truth Dataset, connected to the Evaluate's `ground_truth` port: rows with the expected values,
  sharing enough information with the Generate's input (an id column, or the input text itself) to pair rows.
- Mapping rules: each rule pairs one Generate output field with one or more ground-truth columns and says how
  values are compared. Rules can also pair Generate input columns with ground-truth columns to decide which
  ground-truth row belongs to which model output row.

Instead of rules, an Evaluate node can use custom match code: a Python `match(input_row, output_row, gt_row)`
function that returns truthy when a model output row and a ground-truth row match. Pairing is first-fit: each Generate
row takes the first unclaimed ground-truth row that matches.

Both modes run explicitly: request a `run_nodes` job with `kind: score` and `node` set to the
Evaluate. Each Run saves a new immutable History attempt with the Generate record, actual ground
truth, rules/code, exclusions, metrics and comparison rows. Code mode uses Python in Settings.
Changing inputs keeps earlier results visible with an update notice. Run Evaluate again before
creating a new Optimize. `inspect_node` includes Evaluate History and `resultsFromEarlierSetup`.

Each Optimize node is permanently bound to the completed Evaluate record used at creation.
Verify, Resume and suggestion optimization use the bound Prompt, schema, input table, ground truth
and rules/code. A newer Evaluate does not invalidate the old experiment. To use the newer record,
create a separate Optimize. Legacy Optimize results stay readable; an incomplete legacy source
cannot be used for new execution. Source History cannot be deleted while an Optimize references it.

## Comparison options per rule

- Text: exact by default, optionally ignoring case, symbols or whitespace, or matching when one value
  contains the other.
- Numbers: exact, within an absolute or relative tolerance, or equal after rounding to N decimals.
- Meaning: semantic alignment, embedding similarity, or concept matching through RxNorm or MeSH for drug
  and medical terms.

Choose the loosest comparison that still reflects correctness for the task. Too strict and formatting
noise looks like model error; too loose and real errors pass.

## Grouped rules and excluding rows

For nested AND/OR rules, inspect `details.rules.ruleTree` and pass the complete edited `{v: 2, input,
output}` as `rule_tree` to add_score or update. Keep every group, its `children`, its `ops` and the leaf
`matchFlags`. Flat comparison/all/any is only for flat rules; it cannot represent grouped conditions.
Inspecting the rule tree preserves the exact stored structure instead of just listing its leaves.

To exclude a known invalid row, propose update with `exclude_row_keys`; use `include_row_keys` to bring
it back. Use the exact `rowKey` from read_rows: zero-based GT keys such as "0", or unpaired Generate-result keys such
as "run:0". Change inclusion separately from rules or inputs. Run Evaluate again to update metrics and the inputs of
future Optimize runs; existing Optimize nodes retain the evidence they were created with.

## Reading results

The Evaluate reports matched and unmatched rows, ground-truth rows with no model output row (gt_only), the pass rate
and, where applicable, precision, recall and F1. Rows can be excluded from scoring when they are known to
be invalid.

When explaining a low score, read the unmatched comparison rows and group them by cause before drawing
conclusions: parse errors, missing values, formatting differences (a scoring problem), wrong values (a
prompt or model problem), and ground-truth mistakes. Quote a few representative rows.
