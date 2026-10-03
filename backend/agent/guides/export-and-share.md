# Export and sharing

## Export as Python

The Current Pipeline panel exports the selected route as a standalone Python project (a zip):

- `main.py` runs the route in order; `processor/` holds one module per Process; `prompt/` holds one
  module per Prompt/Run pair with its input mapping, output schema and model; `engine/` provides LLM
  access through LiteLLM or OpenRouter.
- `pipeline.json` is the portable description of the route; `DATA.md` lists the required input columns
  and their types (text, image, pdf); `.env.example` names the API keys to set.
- Input and output are Excel workbooks. Image and pdf cells hold a JSON list of file paths relative to
  the workbook.
- No data is included: no Dataset rows, images or pdfs.

Only the route selected in the panel is exported. Alternatives visible on the canvas but not selected
(other prompt versions, other Runs, other Dataset branches) are left out, as are Score and Review nodes.
A route exports only if it starts with a Dataset and contains at least one Process or Prompt Run, every
Prompt has content and at least one output field, and every Process defines `process(df)`. A route of
only Processes exports without `prompt/`, `engine/` or `.env.example`, and needs no API key.

## Gallery (web)

On the web version, a project can be published to the Gallery from the Publish button in the top bar.
Publications are reviewed by an administrator before they become public, and show the author's name.
Others can add a published project to their own account as an independent copy.

## Desktop and web

The desktop app keeps projects as local files and runs Process code with the Python chosen in Settings.
The web version keeps projects on the server in a per-user workspace. Projects can be moved between them
by exporting and importing the project file.
