# Python Pipeline Export

## Goal

Export the route currently selected in **Current Pipeline** as a standalone Python code project.
The archive must be runnable outside AnnoBio, readable as ordinary Python, and easy to edit without
knowing AnnoBio's canvas storage format. User data is not included in the archive.

The selected route is the export boundary. Alternative Prompt runs and Dataset branches that are
visible on the canvas but not selected in the Current Pipeline pickers are not included.

## Archive layout

```text
<pipeline-name>/
  README.md
  pipeline.json
  main.py
  requirements.txt
  .env.example
  DATA.md
  processor/
    __init__.py
    processor_01_clean_rows.py
    ...
  prompt/
    __init__.py
    prompt_01_extract_sites.py
    ...
  engine/
    __init__.py
    base.py
    litellm_engine.py
    openrouter_engine.py
```

`main.py` is the entry point and shows the selected route explicitly in execution order. Canvas
Process nodes become editable modules under `processor/`; selected Prompt/Run pairs become editable
modules under `prompt/`. `engine/` is only responsible for LLM access and ships with both LiteLLM
and OpenRouter implementations. `main.py` handles Excel I/O, route orchestration, progress, and
writing the output path selected on the command line.

`DATA.md` describes the required input columns, their `text`, `image`, or `pdf` types, the expected
Excel sheet, file-path syntax, and a small example. The archive contains no Dataset rows and no
image or PDF files.

`pipeline.json` is the canonical portable representation. Generated Python may evolve, but tools
can continue to consume an older archive by checking `format_version`.

## Canonical manifest

```json
{
  "format": "annobio.pipeline",
  "format_version": 1,
  "name": "site-extraction",
  "entrypoint": "main.py",
  "input": {
    "dataset_id": "dataset-node-id",
    "format": "xlsx",
    "sheet": "Input",
    "columns": [
      {"name": "Abstract", "type": "text"},
      {"name": "Figures", "type": "image"},
      {"name": "Protocol", "type": "pdf"}
    ]
  },
  "steps": [
    {
      "id": "process-node-id",
      "type": "process",
      "name": "clean_rows",
      "mode": "row",
      "source": "processor/processor_01_clean_rows.py"
    },
    {
      "id": "run-node-id",
      "type": "prompt",
      "name": "Extract sites",
      "source": "prompt/prompt_01_extract_sites.py",
      "prompt_node_id": "prompt-node-id",
      "input_mapping": {"abstract": "Abstract"},
      "input_types": {"abstract": "text"},
      "output_schema": {
        "return_shape": "single",
        "fields": [{"key": "site", "type": "str"}]
      },
      "model": {
        "provider": "openai",
        "model": "gpt-4.1-mini",
        "base_url": ""
      }
    }
  ],
  "output": {
    "format": "xlsx"
  }
}
```

IDs are retained for traceability, not used as Python identifiers. File and function names are
sanitized separately and made unique.

## Data format

Excel is the default input and output format because it is the easiest format for users to inspect
and edit. The user's input workbook has an `Input` sheet whose columns match the contract in
`DATA.md` and `pipeline.json`. The manifest preserves column order and whether each column is
`text`, `image`, or `pdf`. Nested Prompt outputs are JSON-encoded inside an Excel cell when they
cannot be represented as a scalar.

An image/PDF cell contains a JSON array of paths, even when it contains one file, for example:

```json
["files/images/microscopy-a.png", "files/images/microscopy-b.png"]
```

The runtime resolves relative paths from the input workbook's directory. Process code receives
normal local filesystem paths; Prompt steps open the same files and attach their bytes to the model
request. Absolute paths are also accepted. Embedded Excel images are not treated as cell values,
and one Dataset cell may reference multiple files.

The selected starting Dataset supplies only the input contract used to generate `DATA.md`; its rows
and assets are not exported. Intermediate and final Datasets are recomputed by the exported code;
saved Run results and cached Process results are not exported as execution state.

## Step mapping

### Process

- `row` mode preserves the user's `process(row)` function.
- `df` mode preserves the user's `process(df)` function and adds `pandas` to requirements.
- The generated entry point imports and calls the function directly, without the subprocess wrapper
  used by the interactive app.

### Prompt and Run

A selected Prompt version and its selected Run become one executable Prompt step:

- Prompt sections are preserved in order and combined with blank lines, matching the app.
- Run input-to-column mappings and Prompt input types are preserved.
- The structured output schema and `single`/`table` return shape are preserved.
- Provider, model, and optional base URL may be exported as non-secret defaults.
- API keys and credential IDs are never exported. The README and `.env.example` describe the
  environment variables the user must set.

#### Duplicated and manually edited Prompts

A duplicated Prompt is an independent snapshot. If the user edits it afterward, the exporter reads
the duplicate node's current name, sections, input types, and output schema; it does not inherit
from, diff against, or import the original Prompt. The selected Run contributes only its current
input-column mapping and non-secret model configuration.

The duplicate must have its own connected Run before it is an executable Current Pipeline choice.
When it is selected, its generated module is separate from the original Prompt's module. Cached Run
results are ignored. Export validation checks the duplicate's current placeholders against the
selected Run's current mapping, so a manual edit that added an unmapped input produces a clear
validation error instead of stale code.

`New version` Prompt nodes may retain their version-family relationship in `pipeline.json` for
traceability, but code generation still uses only the exact selected node's current contents.

### Engine

`engine/base.py` defines the small interface Prompt modules use for structured model calls.
`engine/__init__.py` selects an implementation from environment configuration:

- `litellm_engine.py` supports models and providers routed through LiteLLM.
- `openrouter_engine.py` calls OpenRouter directly and supports its model names and optional
  request metadata.

Prompt modules do not contain provider-specific request code. Switching engines or models does not
change the Pipeline order, Process code, Prompt templates, or input files. API keys remain in the
user's environment and are never written into exported source files.

### Dataset

Datasets define boundaries between executable steps. They are represented in the manifest for
traceability but do not produce redundant Python modules. When one Prompt output feeds another
step, the generated runtime materializes the same `Input: ...` and `Output: ...` columns that the
selected canvas Dataset exposes. The manifest records that boundary's ordered headers, so the next
step's existing input mapping continues to work without being rewritten.

Score and Prompt Review nodes remain outside the executable export format. Sampler results are
represented only by the selected starting Dataset's column contract; sampled rows are not exported.

## Generated project interface

The default command is:

```bash
python -m venv .venv
python -m pip install -r requirements.txt
python main.py --input /path/to/input.xlsx --output output.xlsx
```

Useful optional flags:

```text
--limit N          run only the first N rows
--start-row N      resume from a specific input row
--model MODEL      override the exported model default
--engine ENGINE    choose litellm or openrouter
--sheet SHEET      choose the input workbook sheet
--concurrency N    control concurrent model calls
```

Failures are written alongside successful rows with the input row index and error message, so one
bad row does not discard the rest of a long run.

## Export validation

The export succeeds only when the selected route has:

1. a starting Dataset with at least one defined column;
2. a complete input mapping for every Prompt placeholder;
3. at least one output field for every Prompt;
4. Python code defining `process(row)` or `process(df)` for every Process;
5. a supported, acyclic order from the selected starting Dataset to the selected output.

Validation errors name the visible node and the missing configuration. Secrets, canvas positions,
cached results, review data, and unrelated branches are excluded from the archive.

## UI flow

Each Current Pipeline card gets an **Export Python** button. It exports exactly the route currently
shown by that card's pickers. The frontend sends the live canvas state and selected ordered route to
one backend export endpoint, then downloads `<pipeline-name>.zip`. Before sending, it reduces the
canvas state to the selected nodes and code/configuration fields; Dataset rows, cached results, and
review state never enter the export request. No project asset session is needed because input rows
and files are never included. Browser and desktop surfaces use the same manifest and source generator.
