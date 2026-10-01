# Pipeline execution

The Current Pipeline panel shows a connected Dataset → Process → Prompt/Run graph and exports the
selected route. Whole-Pipeline validation and execution remain available to the Agent and internal
execution layer, but are not exposed as primary panel buttons. A canvas Dataset is a design-time
connection or saved historical result; a Pipeline Artifact is the immutable data produced by one
particular execution.

## Selecting and exporting a route

1. Connect the source Dataset, Process and Prompt/Run nodes. A detected Pipeline currently needs at
   least one Prompt with a Run.
2. In Current Pipeline, choose any Prompt version, Run or Dataset alternatives shown by the route.
3. Select **Export Python Project** to compile, validate and export that route.

## Run, stop and recover

- Agent-initiated whole-Pipeline execution freezes the selected route and every source input, then
  executes Jobs in dependency order. Static Process branches are materialized as separate Artifacts
  and a merge waits for all required branches; the merge Job runs once.
- **Stop** prevents new Jobs from starting and asks the active Job to stop. An already-sent model
  request may still finish and incur cost, but a late response cannot change a cancelled Pipeline to
  succeeded.
- **Retry / Resume** keeps valid successful Job checkpoints. LLM Jobs also keep successful input
  rows and retry only failed, cancelled or unfinished rows. An interrupted Process is rerun as a
  whole Job.
- A new execution revision can reuse unchanged successful upstream Jobs; a changed Job and its
  descendants run again. The previous revision is not modified.

Refreshing the web page reattaches to the last run. If the backend or desktop app exits during a
run, the next status check marks it `interrupted`, after which Retry / Resume is available. Image and
PDF runs prepare a fresh asset session when resumed.

## Results

Select any intermediate or final Artifact to preview it. **Save as Dataset** creates a new canvas
Dataset explicitly. Running a Pipeline never overwrites existing canvas Datasets automatically.

## Python export and Agent

**Export Python Project** consumes the same compiled PipelineSpec as the in-app Runner. Existing
single-source static split/merge routes therefore use the same dependency order in both paths.
Multi-source export and pure Process-only Pipeline detection remain later capabilities.

The Agent can request a whole numbered Pipeline only when the user explicitly asks for it. The
normal confirmation card shows the full default route, input size, models and known/unknown call
counts before execution starts. If route alternatives matter, state the desired route or select it in
Current Pipeline instead of relying on the default.
