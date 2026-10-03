# Current Pipeline

The Current Pipeline panel shows a connected Dataset → Process → Prompt/Run graph and exports the
selected route as a standalone Python project.

## Selecting and exporting a route

1. Connect the source Dataset, Process and Prompt/Run nodes. A detected Pipeline needs at least one
   Prompt with a Run, or a Process. A Dataset read by both Prompt Runs and Processes starts one
   Pipeline for each.
2. In Current Pipeline, choose any Prompt version, Run or Dataset alternatives shown by the route.
3. Select **Export Python Project** to compile, validate and export that route.

## Python export

**Export Python Project** compiles the selected route into a PipelineSpec and generates code in its
dependency order, including existing single-source static split/merge routes. A route of only
Processes exports without the LLM engine, Prompt modules or `.env.example`. Multi-source export
remains a later capability.
