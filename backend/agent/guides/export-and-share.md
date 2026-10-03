# Export and sharing

## Export as Python

Each pipeline in the Current Pipeline panel has an **Export Python Project** button. It exports the
route chosen in that pipeline's pickers as a standalone Python project (a zip). Only the user can press
it; the Agent cannot export.

Every project contains:

- `main.py`, which runs the route in dependency order; `processor/` with one module per Process.
- `pipeline.json`, the portable description of the route; `DATA.md`, the required input columns and
  their types (text, image, pdf); `README.md`; `requirements.txt`.

When the route has a Prompt Run, it also contains `prompt/` (one module per Prompt/Run pair with its
input mapping, output schema and model), `engine/` (LLM access through LiteLLM or OpenRouter) and
`.env.example` (the API keys to set). A route of only Processes has none of these and needs no API key.

- Input and output are Excel workbooks. Image and pdf cells hold a JSON list of file paths relative to
  the workbook. When the route ends in several Datasets, the output workbook has one sheet per Dataset.
- No data is included: no Dataset rows, images or pdfs.

Only the chosen route is exported. Alternatives visible on the canvas but not chosen (other prompt
versions, other Runs, other Processes, other Dataset branches) are left out, as are Score and Review
nodes.

A route exports only if:
- it starts from exactly one Dataset. A route that merges Datasets coming from different starting
  Datasets is valid on the canvas but cannot be exported yet;
- every Prompt has content and at least one output field, and every Run maps each Prompt input to an
  existing column of the right type (an unmapped input is matched to a column of the same name when
  there is exactly one);
- every Process defines `process(df)`. A Process at the end of the route without a saved output Dataset
  must return one DataFrame, not named branches.

If export fails, the panel shows the reason. Fix the named node and export again.

## Export the Prompt Optimization table

The Prompt Optimization tab has an **Export Excel** button for each prompt. The workbook has the same
columns as the table (Version, From, Run, Score, Ground truth, Precision, Recall, F1); the version tree
is written into the Version text, and the metrics are percentages. Only the user can press it.

## Gallery (web)

On the web version, a project can be published to the Gallery from the Publish button in the top bar.
Publications are reviewed by an administrator before they become public, and show the author's name.
Others can add a published project to their own account as an independent copy.

## Desktop and web

The desktop app keeps projects as local files and runs Process code with the Python chosen in Settings.
The web version keeps projects on the server in a per-user workspace. Projects can be moved between them
by exporting and importing the project file.
