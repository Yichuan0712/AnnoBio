# Pipeline

Evaluate has its own History alongside Pipeline execution. Both rules and code run explicitly with
**Run** and save independent attempts. Changed inputs leave the previous evaluation visible with an
update notice. Each Optimize node stays bound to its original evaluation; use a new Optimize to work
from another evaluation. Optimize status notices appear below Findings. See
[Evaluate History design](design/EVALUATION_HISTORY.md).

Evaluate's String match options include **HGNC (human gene)**, **PubChem (compound)**, and
**Ontology** with a GO / ChEBI / MONDO selector. Select an output field and a ground-truth column,
choose one match option, and click Run. Names, synonyms and supported IDs match only when both
uniquely resolve to the same standard ID. HGNC is human-only; PubChem preserves distinct compound
CIDs. Ambiguous or unresolved names do not match; a failed lookup stops the evaluation with an
error rather than producing a false mismatch. Lookups are deduplicated and cached.
Rules progress reflects completed entity lookups, semantic comparisons and row comparisons. The
results table and metrics update together after the full attempt finishes; previous results stay
visible while it runs. Code matching retains its existing row progress.

The Pipeline panel shows the Generate and Process steps that pass data to each other, starting
from Datasets. It selects the route to export as a standalone Python project; use Resume pipeline to here on a
step to run it and the upstream steps it needs.

## Building a pipeline

1. Start from a Dataset. Datasets are the only inputs of a pipeline: a pipeline starts at the
   Datasets its steps read.
2. Connect steps directly, on the canvas. Every node has dots on its edges: inputs on the left,
   outputs on the right. Drag from an output to an input to connect them; drop a line on empty
   canvas to start a new step on that output (**Create Generate from results**, **Create Process from
   results**, the same items as the step's context menu). A Process with several output branches has
   one dot per branch; each branch can feed a different step, and a later Process can merge them.
3. A Generate reads exactly one input. A Process reads its `df` input plus one input per `df_<name>`
   parameter of its code: drag an output toward the Process to reveal its **Add input** dot, then drop
   the line on that dot to add one; or write the parameter
   in the code and connect its dot. Generate and Process input rows show source names, with icons for
   Prompts and tables; port hover text starts with **Input:** or **Output:** and describes the source or output. Process parameter names remain in its code editor. Node windows show what a node
   reads; they no longer choose it.

**Save to workspace** (Generate or Process) is for freezing or editing data: it
save the current output as an ordinary Dataset, which records where it came from and is drawn with
a line between hollow dots from that step. A step that reads this Dataset starts a new pipeline from it; it
does not follow the step it was saved from.

## Selecting a route

Click a Pipeline's name to rename it in place. Press Enter or click elsewhere to save; Escape
cancels. Blank input keeps the previous name. Names are saved with the project, support undo/redo,
and stay with their entry steps when other pipelines are renumbered or downstream steps are added.
Python exports use the custom Pipeline name by default.

In Pipeline, choose any Prompt version or Generate alternative shown by the route. A Process's
branches are drawn as aligned lanes with continuous connections. A branch that feeds the shared
next step directly is drawn as a continuous bypass line. Outputs with no downstream step are
omitted from the overview. When only one connected path remains, it is shown as a straight
continuation; when none remain, the overview ends at the current step. All output ports remain
available on the canvas, and execution and export still use the complete selected route.
Long routes scroll horizontally instead of wrapping onto another row.

Click a step, or focus it and press Enter or Space, to locate its nodes on the canvas. Hovering or
focusing a step highlights its canvas nodes and adjoining connections in the overview. Version
pickers remain inside their step cards; changing one updates the continuation and the export route.

## Run

A Generate or Process node's right-click menu provides three execution scopes:

- **Run only this node** starts this node from the beginning using its current upstream results.
  It is disabled when a required upstream result is unavailable.
- **Resume pipeline to here** reuses valid completed results, resumes compatible partial Generate
  results, and runs missing or outdated steps up to this node. It appears only when an upstream
  step needs execution. If everything is current, Resume does nothing; it never silently reruns.
- **Restart pipeline to here** starts every required upstream step and this node from the beginning,
  without reusing completed or partial results. It appears when upstream steps exist and there is
  prior work, so it differs from the other actions. Its plan always shows before execution.

An interrupted Generate with unchanged inputs also offers **Resume** to continue only that node;
**Run only this node** still starts it fresh. Process code always starts from the beginning.
The plan lists inputs, reused results and the steps that will run. Execution follows actual data
dependencies, including every required merge input, and stops at this node. Unrelated branches,
downstream nodes and Prompt optimization provenance connections are excluded. A saved Dataset is
an input boundary; it does not rerun the step it was saved from.

The **Run** tab records the mode and each step's outcome. Running tasks offer **Stop**.
Resuming an interrupted Restart keeps newly finished steps and partial progress, while its unstarted
steps still run freshly. Each fresh step creates a new History attempt; older results remain available.

A step whose inputs changed since its last run shows **Historical**; its window still shows the
earlier result. Running it, or changing its inputs back, clears the mark.

## Python export

**Export Python Project** compiles the selected route into a PipelineSpec and generates code in its
dependency order, including branches and merges. Inputs are named after their Datasets; outputs
after the Prompt, the Process, or the branch that produced them. A route of only Processes exports
without the LLM engine, Prompt modules or `.env.example`.
