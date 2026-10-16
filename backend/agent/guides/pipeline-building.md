# Building a pipeline

A pipeline turns input tables into annotated output. It starts from Datasets and is a chain of Prompt
Generate and Process steps that read each other's output directly, with at least one Prompt/Generate step or Process.
Evaluate and Optimize sit beside it for evaluation and are not part of the exported pipeline.

## Choosing the step type

- Use a **Process** for anything deterministic: cleaning text, filtering rows, splitting or exploding
  columns, joining tables on a key, deduplicating, reshaping LLM output into final columns. It is fast,
  free and reproducible. See the `process-code` guide.
- Use a **Prompt + Generate** only for judgement a rule cannot express: extraction from free text,
  classification, normalisation to a vocabulary, reading figures (image columns) or documents (pdf
  columns). See the `prompt-design` guide.
- Use a **Sampler** to draw a small subset for iterating on a prompt before running it on everything.
  See `dataset-editing` for repeated sampling, finite without-replacement quotas and content locks.

## Typical shapes

- Single extraction: Dataset -> Prompt/Generate.
- Clean then extract: Dataset -> Process -> Prompt/Generate (the Generate reads the Process's output).
- Multi-stage LLM: Generate -> Process -> Generate, each step reading the previous step's output; a Process in
  between reshapes the first Generate's results into the columns the next Prompt needs.
- Merge sources: two Datasets, or a Dataset and a step's output -> Process (`df` plus `df_<other_name>`,
  joined on a shared key) -> Prompt/Generate.
- Branch: a Process returns named DataFrames (for example `{"with_figures": ..., "text_only": ...}`);
  each branch is an output of its own, read by a different Prompt/Generate, and a later Process can merge
  them again.

## How the pieces connect

- Steps connect directly through data connections: a step's input is a Dataset or another step's
  output (a Generate's results, or one branch of a Process). There is no Dataset in between.
- A Generate reads exactly one input and maps every `{variable}` of its Prompt to a column of it. A column's
  type must fit the variable's input type (text, image or pdf). A Generate's results, as the next step reads
  them, have the columns `Input: #`, `Input: <column>` for each input column, `Output: #` and
  `Output: <field>` for each output field.
- A step's columns are known once it has a result, so map a Generate that reads another step after that
  step has run (the Generate window works the same way). Plan the build as stages: add a step, run it, then
  add and map the next.
- A Process's `df` is the input on its `df` port; every other input (a Dataset or a step output) is a
  `df_<name>` parameter with a port of its own. A parameter named after an input's alias connects that
  input automatically; one that names no input is an empty port until an output is connected to it
  (connect, or dragging on the canvas), and the Process cannot run until then. A Process's branches
  are known once its code has been checked (shortly after it is saved) or it has run; only then can
  another step read one of them.
- Users connect inputs by dragging lines between the dots on node edges (inputs on the left, outputs on
  the right). Letting a line go over empty canvas offers new steps on that output; dropping it on a
  Process's **Add input** port (revealed while dragging a compatible output; `+` in tool calls) adds an input. Generate and Process input rows show source
  names; port hover text starts with **Input:** or **Output:** and names the source or output. Tool IDs and code aliases stay the same; Process parameter names appear in the code editor. Node windows show
  what a node reads but do not choose it. Use
  connect and disconnect to change an existing step's inputs.
- **Save to workspace** in the Generate window (**Save results to workspace** in its context menu) and
  **Create dataset** / **Create branch datasets** in Process save the current output as an ordinary
  Dataset, only to freeze or hand-edit it. The Dataset records where it came from but does not follow
  that step; a step reading it starts a new pipeline from it.
- New prompt versions are linked by `prompt-to-prompt` connections; each version gets its own Generate node.

## Pipeline and alternatives

The Pipeline tab of the bottom panel (opened with the toolbar button beside Agent Assistant)
lists each pipeline as one route. Its steps are "Generate" and "Process"; Datasets are not
shown. Where a step has alternatives, such as several prompt versions with Generate nodes, several Generate nodes of one
Prompt (also on different inputs), or several Processes reading the same input, the panel shows a
picker on that step, and the rest of the route follows the choice. Branches come only from a Process:
its named outputs (one lane each, empty when nothing reads that branch), or the inputs one Process
merges.

A pipeline needs at least one Prompt with a Generate, or a Process; a pipeline of only Processes is valid.
A Dataset read by both Prompt/Generate steps and Processes starts separate pipelines, one per step type, rather
than a mixed picker. Hovering a step highlights its Prompt, Generate or Process and the Datasets it reads;
clicking it finds them on the canvas. The chosen route is what Export Python Project uses.

The workspace summary describes the route currently selected in the panel, or labels it as the default
route when the panel has not been mounted. Only the user can change a picker; after a change, refresh
the workspace before acting.

**Run only this node** starts just that node from the beginning using current upstream results.
**Resume pipeline to here** reuses current completed results, continues compatible partial Generate
results, and fills missing or outdated steps up to the target. If everything is current, nothing runs.
**Restart pipeline to here** starts every required upstream step and the target from the beginning,
ignoring completed and partial progress while keeping old History. The menu hides equivalent scopes:
Resume is shown only when upstream work is needed; Restart only when upstream steps and prior work exist.
Partial Generate nodes also offer **Resume** to continue only that node. Running tasks offer **Stop**.
The plan states which inputs are read, which results are reused and which steps execute.
Scope follows actual data dependencies, including all merge inputs, and excludes unrelated branches,
downstream nodes and provenance connections. A saved Dataset is a boundary.
Each run is listed in **Executions**, where it can be stopped or resumed. Continuing an interrupted
Restart keeps its freshly completed steps but still reruns unstarted steps with old results.
Every fresh step creates a new History attempt. The Agent uses a `run_nodes` job of kind `run_to`
with `mode: resume` (default), `restart`, `only`, or `resume-node`. `only_this: true` remains an alias
for `mode: only`. The user confirms the plan on a card.
Use `run_nodes` for a single Generate or Process when testing or iterating on one stage.
Use kind `stop` with a node id to request cancellation of a running Generate, Process, code Evaluate,
Optimize or suggestion optimization, including tasks started in the UI. Refresh the workspace to
check when it actually stops; a request is not proof that the task has finished. Already issued
model calls may complete. Suggestion verification cannot be stopped part-way.

## Advising on a design

Start from the user's goal and their data: what is one row, which columns carry the evidence, what
should the final table look like. Propose the smallest route that produces it, put deterministic work in
Process steps, and plan an evaluation (a ground-truth Dataset and an Evaluate node) before optimising prompts.
