# Current Pipeline

The Current Pipeline panel shows the Run and Process steps that pass data to each other, starting
from Datasets. It runs the selected route as a whole or exports it as a standalone Python project.

## Building a pipeline

1. Start from a Dataset. Datasets are the only inputs of a pipeline: a pipeline starts at the
   Datasets its steps read.
2. Connect steps directly. A Run or Process reads another step's output: in its window, pick it
   under **Step outputs** in Input, or use the step's context menu (**Run a prompt on results**,
   **Process results with code**). A Process with several output branches shows one port per
   branch; each branch can feed a different step, and a later Process can merge them.
3. A Run reads exactly one input. A Process reads its `df` input plus any others under their
   `df_<name>` aliases.

**Save results** (Run) and **Create dataset** (Process) are only for freezing or editing data: they
save the current output as an ordinary Dataset, which records where it came from and is drawn with
a faint dashed line from that step. A step that reads this Dataset starts a new pipeline from it; it
does not follow the step it was saved from.

## Selecting a route

In Current Pipeline, choose any Prompt version or Run alternative shown by the route. A Process's
branches are drawn as lanes; a branch nothing reads is an empty lane.

## Run Pipeline

**Run Pipeline** lists the Datasets the route starts from, checks that the route compiles, and runs
it in dependency order. A run can be stopped and resumed. When it ends, the results of every step
that finished are added to that step's History and each step shows them; no Datasets are added.
**Run History** lists earlier runs of the pipeline.

## Python export

**Export Python Project** compiles the selected route into a PipelineSpec and generates code in its
dependency order, including branches and merges. Inputs are named after their Datasets; outputs
after the Prompt, the Process, or the branch that produced them. A route of only Processes exports
without the LLM engine, Prompt modules or `.env.example`.
