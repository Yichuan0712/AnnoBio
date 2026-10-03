# Building a pipeline

A pipeline turns input tables into annotated output. It is a chain of Dataset, Process and Prompt/Run
steps with at least one Prompt Run or Process. Score and Review sit beside it for evaluation and are not part of the
exported pipeline.

## Choosing the step type

- Use a **Process** for anything deterministic: cleaning text, filtering rows, splitting or exploding
  columns, joining tables on a key, deduplicating, reshaping LLM output into final columns. It is fast,
  free and reproducible. See the `process-code` guide.
- Use a **Prompt + Run** only for judgement a rule cannot express: extraction from free text,
  classification, normalisation to a vocabulary, reading figures (image columns) or documents (pdf
  columns). See the `prompt-design` guide.
- Use a **Sampler** to draw a small subset for iterating on a prompt before running it on everything.

## Typical shapes

- Single extraction: Dataset -> Prompt/Run -> Dataset (saved Run results).
- Clean then extract: Dataset -> Process -> Dataset -> Prompt/Run -> Dataset.
- Multi-stage LLM: the saved results of one Run become the input Dataset of the next Run.
- Merge sources: two Datasets -> Process (`df` plus `df_<other_name>`, joined on a shared key) ->
  Dataset -> Prompt/Run.
- Branch: a Process returns named DataFrames (for example `{"with_figures": ..., "text_only": ...}`),
  each saved as its own Dataset and handled by a different Prompt/Run.

## How the pieces connect

- A Run reads exactly one input Dataset and maps every `{variable}` of its Prompt to a column of that
  Dataset. A column's type must fit the variable's input type (text, image or pdf).
- Saving a Run's results to the workspace creates a Dataset produced by that Run; its columns are the
  input columns plus the Prompt's output fields.
- A Process's primary input is the Dataset connected into it; other Datasets it references in code as
  `df_<name>` are connected automatically. Each output branch can be saved as a Dataset.
- New prompt versions are linked by `prompt-to-prompt` connections; each version gets its own Run.

## Current Pipeline and alternatives

The Current Pipeline tab of the bottom panel (opened with the toolbar button beside Agent Assistant)
lists each pipeline as one route. Its steps are "Run prompt" and "Process data"; Datasets are not
shown. Where a step has alternatives, such as several prompt versions with Runs, several Runs of one
Prompt (also on different Datasets), or several Processes reading the same Dataset, the panel shows a
picker on that step, and the rest of the route follows the choice. Branches come only from a Process:
its named outputs, or the Datasets one Process merges.

A pipeline needs at least one Prompt with a Run, or a Process; a pipeline of only Processes is valid.
A Dataset read by both Prompt Runs and Processes starts separate pipelines, one per step type, rather
than a mixed picker. Hovering a step highlights its Prompt, Run or Process and the Datasets it reads;
clicking it finds them on the canvas. The chosen route is what Export Python Project uses.

The workspace summary describes the same routes with the panel's default choices. Only the user can
change a picker; if the choice matters, ask which one they selected.

The panel has no button to run a whole pipeline. Run it stage by stage: run each Process and Run in
route order, and save the outputs a later step reads.

## Advising on a design

Start from the user's goal and their data: what is one row, which columns carry the evidence, what
should the final table look like. Propose the smallest route that produces it, put deterministic work in
Process steps, and plan an evaluation (a ground-truth Dataset and a Score) before optimising prompts.
