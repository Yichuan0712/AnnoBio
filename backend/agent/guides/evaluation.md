# Evaluation with Score nodes

## What a Score needs

- An upstream Run with results.
- A ground-truth Dataset, connected to the Score's `ground_truth` port: rows with the expected values,
  sharing enough information with the Run's input (an id column, or the input text itself) to pair rows.
- Mapping rules: each rule pairs one Run output field with one or more ground-truth columns and says how
  values are compared. Rules can also pair Run input columns with ground-truth columns to decide which
  ground-truth row belongs to which Run row.

Instead of rules, a Score can use custom match code: a Python `match(input_row, output_row, gt_row)`
function that returns truthy when a Run row and a ground-truth row match. Pairing is first-fit: each Run
row takes the first unclaimed ground-truth row that matches.

## Comparison options per rule

- Text: exact by default, optionally ignoring case, symbols or whitespace, or matching when one value
  contains the other.
- Numbers: exact, within an absolute or relative tolerance, or equal after rounding to N decimals.
- Meaning: semantic alignment, embedding similarity, or concept matching through RxNorm or MeSH for drug
  and medical terms.

Choose the loosest comparison that still reflects correctness for the task. Too strict and formatting
noise looks like model error; too loose and real errors pass.

## Reading results

The Score reports matched and unmatched rows, ground-truth rows with no Run row (gt_only), the pass rate
and, where applicable, precision, recall and F1. Rows can be excluded from scoring when they are known to
be invalid.

When explaining a low score, read the unmatched comparison rows and group them by cause before drawing
conclusions: parse errors, missing values, formatting differences (a scoring problem), wrong values (a
prompt or model problem), and ground-truth mistakes. Quote a few representative rows.
