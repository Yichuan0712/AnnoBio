# Building a pipeline

A pipeline turns input tables into annotated output. It starts from Datasets and is a chain of Prompt
Runs and Processes that read each other's output directly, with at least one Prompt Run or Process.
Evaluate and Optimize sit beside it for evaluation and are not part of the exported pipeline.

## Choosing the step type

- Use a **Process** for anything deterministic: cleaning text, filtering rows, splitting or exploding
  columns, joining tables on a key, deduplicating, reshaping LLM output into final columns. It is fast,
  free and reproducible. See the `process-code` guide.
- Use a **Prompt + Run** only for judgement a rule cannot express: extraction from free text,
  classification, normalisation to a vocabulary, reading figures (image columns) or documents (pdf
  columns). See the `prompt-design` guide.
- Use a **Sampler** to draw a small subset for iterating on a prompt before running it on everything.
  See `dataset-editing` for repeated sampling, finite without-replacement quotas and content locks.

## Typical shapes

- Single extraction: Dataset -> Prompt/Run.
- Clean then extract: Dataset -> Process -> Prompt/Run (the Run reads the Process's output).
- Multi-stage LLM: Run -> Process -> Run, each step reading the previous step's output; a Process in
  between reshapes the first Run's results into the columns the next Prompt needs.
- Merge sources: two Datasets, or a Dataset and a step's output -> Process (`df` plus `df_<other_name>`,
  joined on a shared key) -> Prompt/Run.
- Branch: a Process returns named DataFrames (for example `{"with_figures": ..., "text_only": ...}`);
  each branch is an output of its own, read by a different Prompt/Run, and a later Process can merge
  them again.

## How the pieces connect

- Steps connect directly through data connections: a step's input is a Dataset or another step's
  output (a Run's results, or one branch of a Process). There is no Dataset in between.
- A Run reads exactly one input and maps every `{variable}` of its Prompt to a column of it. A column's
  type must fit the variable's input type (text, image or pdf). A Run's results, as the next step reads
  them, have the columns `Input: #`, `Input: <column>` for each input column, `Output: #` and
  `Output: <field>` for each output field.
- A step's columns are known once it has a result, so map a Run that reads another step after that
  step has run (the Run window works the same way). Plan the build as stages: add a step, run it, then
  add and map the next.
- A Process's `df` is the input on its `df` port; every other input (a Dataset or a step output) is a
  `df_<name>` parameter with a port of its own. A parameter named after an input's alias connects that
  input automatically; one that names no input is an empty port until an output is connected to it
  (connect, or dragging on the canvas), and the Process cannot run until then. A Process's branches
  are known once its code has been checked (shortly after it is saved) or it has run; only then can
  another step read one of them.
- Users connect inputs by dragging lines between the dots on node edges (inputs on the left, outputs on
  the right). Letting a line go over empty canvas offers new steps on that output; dropping it on a
  Process's **Add input** port (revealed while dragging a compatible output; `+` in tool calls) adds an input. Run and Process input rows show source
  names; port hover text starts with **Input:** or **Output:** and names the source or output. Tool IDs and code aliases stay the same; Process parameter names appear in the code editor. Node windows show
  what a node reads but do not choose it. Use
  connect and disconnect to change an existing step's inputs.
- **Save to workspace** in the Run window (**Save results to workspace** in its context menu) and
  **Create dataset** / **Create branch datasets** in Process save the current output as an ordinary
  Dataset, only to freeze or hand-edit it. The Dataset records where it came from but does not follow
  that step; a step reading it starts a new pipeline from it.
- New prompt versions are linked by `prompt-to-prompt` connections; each version gets its own Run.

## Current Pipeline and alternatives

The Current Pipeline tab of the bottom panel (opened with the toolbar button beside Agent Assistant)
lists each pipeline as one route. Its steps are "Run prompt" and "Process data"; Datasets are not
shown. Where a step has alternatives, such as several prompt versions with Runs, several Runs of one
Prompt (also on different inputs), or several Processes reading the same input, the panel shows a
picker on that step, and the rest of the route follows the choice. Branches come only from a Process:
its named outputs (one lane each, empty when nothing reads that branch), or the inputs one Process
merges.

A pipeline needs at least one Prompt with a Run, or a Process; a pipeline of only Processes is valid.
A Dataset read by both Prompt Runs and Processes starts separate pipelines, one per step type, rather
than a mixed picker. Hovering a step highlights its Prompt, Run or Process and the Datasets it reads;
clicking it finds them on the canvas. The chosen route is what Export Python Project uses.

The workspace summary describes the route currently selected in the panel, or labels it as the default
route when the panel has not been mounted. Only the user can change a picker; after a change, refresh
the workspace before acting.

**Run to here** runs a step together with every step before it that has no current result, and
reuses the steps that have one. The user starts it from a step's Run button (when an input has no
result yet) or its right-click menu, and sees a plan first: what it reads, what it reuses, what runs.
To run a whole pipeline, run to its last step. Each such run is listed in the **Executions** tab, where
it can be stopped or resumed. Every step's result goes into that step's History. The Agent requests
the same with a `run_nodes` job of kind `run_to`, which the user confirms on a card.
Use `run_nodes` for a single Run or Process when testing or iterating on one stage.
Use kind `stop` with a node id to request cancellation of a running Run, Process, code Evaluate,
Optimize or suggestion optimization, including tasks started in the UI. Refresh the workspace to
check when it actually stops; a request is not proof that the task has finished. Already issued
model calls may complete. Suggestion verification cannot be stopped part-way.

## Advising on a design

Start from the user's goal and their data: what is one row, which columns carry the evidence, what
should the final table look like. Propose the smallest route that produces it, put deterministic work in
Process steps, and plan an evaluation (a ground-truth Dataset and an Evaluate node) before optimising prompts.
