# Process code

A Process node runs one Python function over whole tables. There is no LLM involved.

## Contract

```python
import pandas as pd

def process(df):
    # df: the primary input Dataset as a pandas DataFrame (all values as they appear in the table)
    return df  # a DataFrame, or {"branch_name": DataFrame, ...}
```

- `df` is the Dataset connected into the Process (its primary input).
- Every other Dataset on the canvas is available as a global DataFrame named `df_<dataset_name>`: the
  Dataset name lower-cased, accents removed, and each run of characters outside `a-z0-9_` replaced by
  `_`. For example a Dataset called "ChEMBL targets (v2)" is `df_chembl_targets_v2`. If two names
  collide, later ones get `_2`, `_3`, ... Referencing an alias in the code connects that Dataset to the
  Process automatically. Check the exact aliases with inspect_node on the Process.
- Return one DataFrame (shown as the `result` branch) or a dict mapping non-empty, unique branch names
  to DataFrames. Each branch can be saved as its own Dataset.
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
  columns do not survive a Process, so a Prompt that needs the files must read a Dataset that still
  holds them.
- Column order in the returned DataFrame is the column order of the saved Dataset.

## Patterns

Join two sources on a key:

```python
def process(df):
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
