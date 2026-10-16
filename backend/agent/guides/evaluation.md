# Evaluation with Evaluate nodes

## What an Evaluate node needs

- An upstream Run with results.
- A ground-truth Dataset, connected to the Evaluate's `ground_truth` port: rows with the expected values,
  sharing enough information with the Run's input (an id column, or the input text itself) to pair rows.
- Mapping rules: each rule pairs one Run output field with one or more ground-truth columns and says how
  values are compared. Rules can also pair Run input columns with ground-truth columns to decide which
  ground-truth row belongs to which Run row.

Instead of rules, an Evaluate node can use custom match code: a Python `match(input_row, output_row, gt_row)`
function that returns truthy when a Run row and a ground-truth row match. Pairing is first-fit: each Run
row takes the first unclaimed ground-truth row that matches.

Rule-based Evaluate nodes compute automatically. Custom match code runs explicitly: after configuring
`match_code`, request a `run_nodes` job with `kind: score` and `node` set to the Evaluate. It runs the
same Python matcher as the Evaluate window, reports progress, stores the result and retains partial
results on cancellation. It uses the Python interpreter in Settings and makes no model calls.
Run this job before requesting an Optimize node of an Evaluate node that uses code matching.

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
it back. Use the exact `rowKey` from read_rows: zero-based GT keys such as "0", or unpaired Run keys such
as "run:0". Change inclusion separately from rules or inputs. This updates metrics and the inputs of
future Optimize runs; existing Optimize nodes retain the evidence they were created with.

## Reading results

The Evaluate reports matched and unmatched rows, ground-truth rows with no Run row (gt_only), the pass rate
and, where applicable, precision, recall and F1. Rows can be excluded from scoring when they are known to
be invalid.

When explaining a low score, read the unmatched comparison rows and group them by cause before drawing
conclusions: parse errors, missing values, formatting differences (a scoring problem), wrong values (a
prompt or model problem), and ground-truth mistakes. Quote a few representative rows.
