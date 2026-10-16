# Current Pipeline

The Current Pipeline panel shows the Run and Process steps that pass data to each other, starting
from Datasets. It runs the selected route as a whole or exports it as a standalone Python project.

## Building a pipeline

1. Start from a Dataset. Datasets are the only inputs of a pipeline: a pipeline starts at the
   Datasets its steps read.
2. Connect steps directly, on the canvas. Every node has dots on its edges: inputs on the left,
   outputs on the right. Drag from an output to an input to connect them; drop a line on empty
   canvas to start a new step on that output (**Run a prompt on results**, **Process results with
   code**, the same items as the step's context menu). A Process with several output branches has
   one dot per branch; each branch can feed a different step, and a later Process can merge them.
3. A Run reads exactly one input. A Process reads its `df` input plus one input per `df_<name>`
   parameter of its code: drag an output toward the Process to reveal its **Add input** dot, then drop
   the line on that dot to add one; or write the parameter
   in the code and connect its dot. Run and Process input rows show source names, with icons for
   Prompts and tables; port hover text starts with **Input:** or **Output:** and describes the source or output. Process parameter names remain in its code editor. Node windows show what a node
   reads; they no longer choose it.

**Save results** (Run) and **Create dataset** (Process) are only for freezing or editing data: they
save the current output as an ordinary Dataset, which records where it came from and is drawn with
a line between hollow dots from that step. A step that reads this Dataset starts a new pipeline from it; it
does not follow the step it was saved from.

## Selecting a route

In Current Pipeline, choose any Prompt version or Run alternative shown by the route. A Process's
branches are drawn as lanes; a branch nothing reads is an empty lane.

## Run to here

**Run to here** (a step's right-click menu, or its Run button when an input has no result yet) runs
that step and every step before it that has no current result, reusing the steps that have one. A
plan shows first: the Datasets it reads, the results it reuses and the steps it runs, in order. To
run a whole pipeline, run to its last step. The **Executions** tab lists these runs; a running one
can be stopped, and a stopped or failed one resumed. Each step's result goes into its History.

A step whose inputs changed since its last run shows **Needs update**; its window still shows the
earlier result. Running it, or changing its inputs back, clears the mark.

## Python export

**Export Python Project** compiles the selected route into a PipelineSpec and generates code in its
dependency order, including branches and merges. Inputs are named after their Datasets; outputs
after the Prompt, the Process, or the branch that produced them. A route of only Processes exports
without the LLM engine, Prompt modules or `.env.example`.
