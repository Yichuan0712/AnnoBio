# Export and sharing

## Export as Python

Each pipeline in the Pipeline panel has an **Export Python Project** button. It exports the
route chosen in that pipeline's pickers as a standalone Python project (a zip). The Agent can request
the same export through `pipeline_action`; the user confirms it before the download starts.

Every project contains:

- `main.py`, which runs the route in dependency order; `processor/` with one module per Process.
- `pipeline.json`, the portable description of the route; `DATA.md`, the required input columns and
  their types (text, image, pdf); `README.md`; `requirements.txt`.

When the route has a Prompt/Generate step, it also contains `prompt/` (one module per Prompt/Generate pair with its
input mapping, output schema and model), `engine/` (LLM access through LiteLLM or OpenRouter) and
`.env.example` (the API keys to set). A route of only Processes has none of these and needs no API key.

- Input and output are Excel workbooks. Image and pdf cells hold a JSON list of file paths relative to
  the workbook. A route that starts from several Datasets takes one workbook per Dataset
  (`--input DATASET_ID=FILE.xlsx`). The output workbook has one sheet per final output: each step
  output nothing else in the route reads, named after its Prompt, its Process, or its branch.
- No data is included: no Dataset rows, images or pdfs.

Only the chosen route is exported. Alternatives visible on the canvas but not chosen (other prompt
versions, other Generate nodes, other Processes) are left out, as are Evaluate and Optimize nodes. Datasets saved
from a step are not part of the route: the export follows the steps' direct connections.

A route exports only if:
- every step it reads is in the route (a step reading one left out is reported by name);
- every Prompt has content and at least one output field, and every Generate maps each Prompt input to an
  existing column of the right type (an unmapped input is matched to a column of the same name when
  there is exactly one);
- every Process defines `process(df, ...)`, with one parameter per other input, and returns every
  branch its code was detected to return.

If export fails, the panel shows the reason. Fix the named node and export again.

## Prompt

The Prompt tab draws each prompt family left to right, like the Pipeline tab, with Prompt steps and
Evaluate & Optimize steps between versions. Click a step to locate and highlight it on the canvas, or a
version's Compare button to compare it with its parent. Export Prompt content from its node window; the
Prompt tab has no evaluation table or Excel export.

## Gallery (web)

On the web version, a project can be published to the Gallery from the Publish button in the top bar.
Publications are reviewed by an administrator before they become public, and show the author's name.
Others can add a published project to their own account as an independent copy.

## Desktop and web

The desktop app keeps projects as local files and runs Process code with the Python chosen in Settings.
The web version keeps projects on the server in a per-user workspace. Projects can be moved between them
by exporting and importing the project file.
