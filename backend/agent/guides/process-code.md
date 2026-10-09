# Process code

A Process node runs one Python function over whole tables. There is no LLM involved.

## Contract

```python
import pandas as pd

def process(df, df_chembl_targets):
    # df: the primary input (a Dataset or a step's output) as a pandas DataFrame
    # df_chembl_targets: another input, declared as a parameter named after its alias
    return df  # a DataFrame, or {"branch_name": DataFrame, ...}
```

- `df` is the first parameter: the Process's primary input. An input is a Dataset or another step's
  output: a Run's results (columns `Input: #`, `Input: <column>`, `Output: #`, `Output: <field>`), or
  one branch of a Process.
- Every other input is a parameter after `df`, named after its alias `df_<name>`. The name is a
  Dataset's name, the Prompt name of a Run, a Process's name for its single output, or the branch name
  for one of several branches; lower-cased, accents removed, and each run of characters outside
  `a-z0-9_` replaced by `_`. For example a Dataset called "ChEMBL targets (v2)" is
  `df_chembl_targets_v2` and a branch `needs_review` is `df_needs_review`. If two names collide, later
  ones get `_2`, `_3`, ... Declaring a parameter connects that input to the Process, just as checking
  it under Input in the Process window adds the parameter. An input keeps its alias when it is renamed,
  so check the exact aliases with inspect_node on the Process (`availableInputs`).
- A step's output can be read once that step has a complete result; until then the Process waits for it.
- Older code reads another Dataset as a global `df_<dataset_name>` without declaring it; that still
  works, but new code declares every input as a parameter.
- Return one DataFrame (shown as the `result` branch) or a dict mapping non-empty, unique branch names
  to DataFrames. Each branch is an output other steps can read directly; it can also be saved as a
  Dataset to freeze it. Always return every branch, empty when it has no rows: a pipeline needs each
  branch the code was detected to return.
- Returning anything else is an error. The run times out after 120 seconds.

## Environment

The code runs in the Python interpreter chosen in Settings -> Python (desktop), or in the workspace's
own Python (web). pandas must be installed there. Other libraries are available only if installed in
that interpreter, so prefer pandas and the standard library.

## Data details

- Text cells arrive as strings; empty cells are empty strings, not NaN. Convert explicitly
  (`pd.to_numeric(df["x"], errors="coerce")`) before doing arithmetic.
- Image and pdf cells arrive as a Python list of local file paths, so code can open the files.
- Every returned value becomes a text cell. Return strings, numbers, booleans or None; convert lists
  and dicts with `json.dumps` yourself, otherwise they are stored as unreadable text. Image and pdf
  columns do not survive a Process, so a Prompt that needs the files must read a Dataset or a Run's
  results that still hold them.
- Column order in the returned DataFrame is the column order of the output.

## Patterns

Join two sources on a key:

```python
def process(df, df_chembl_targets):
    targets = df_chembl_targets[["target_id", "pref_name"]].drop_duplicates("target_id")
    return df.merge(targets, on="target_id", how="left")
```

Split into branches:

```python
def process(df):
    has_fig = df["Figures"].astype(str).str.len() > 2
    return {"with_figures": df[has_fig], "text_only": df[~has_fig]}
```

Explode a JSON list produced by a Run into one row per item:

```python
import json

def process(df):
    df = df.copy()
    df["site"] = df["sites"].apply(lambda s: json.loads(s) if s else [])
    return df.explode("site").drop(columns=["sites"])
```

## Older projects

Projects saved before the dataframe contract may contain `process(row)` code. AnnoBio wraps it
automatically in an equivalent `process(df)`; new code should use `process(df)` directly.
