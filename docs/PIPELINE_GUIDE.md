# Pipeline

The Pipeline panel shows the Generate and Process steps that pass data to each other, starting
from Datasets. It selects the route to export as a standalone Python project; use Run to here on a
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

A Generate or Process step's right-click menu has two ways to run it:

- **Run to here** (also what its Run button does when an input has no result yet) runs that step
  and every step before it that has no current result, reusing the steps that have one. A plan shows
  first: the Datasets it reads, the results it reuses and the steps it runs, in order. To run a whole
  pipeline, use Run to here on its last step.
- **Run this step** runs only that step. It is unavailable while a step it reads has no current
  result; use Run to here then.

When the step and everything before it already have current results, either one runs the step again.
The **Executions** tab lists these runs; a running one can be stopped, and a stopped or failed one
resumed. Each step's result goes into its History.

A step whose inputs changed since its last run shows **Needs update**; its window still shows the
earlier result. Running it, or changing its inputs back, clears the mark.

## Python export

**Export Python Project** compiles the selected route into a PipelineSpec and generates code in its
dependency order, including branches and merges. Inputs are named after their Datasets; outputs
after the Prompt, the Process, or the branch that produced them. A route of only Processes exports
without the LLM engine, Prompt modules or `.env.example`.
