"""User-facing guide content. Screenshot captions describe the visible task, not UI internals."""

GUIDE_GROUPS = {
    "overview": "Build a pipeline",
    "evaluate-results": "Improve a prompt",
    "agent-assistant": "Work with the Agent",
    "key-concepts": "Reference",
}


def build_chapters(fig):
    return [
        ("overview", "What you will build", lambda: """
<p>AnnoBio is a workspace for turning biomedical literature and research records into structured,
reviewable datasets. It supports text and multimodal data mining across abstracts, full-text PDFs,
clinical notes, tables, and images. Typical tasks include extracting entities, relations, measurements,
and supporting evidence; classifying records by relevance or study design; and normalizing terminology
to standard identifiers. These operations can be combined into reproducible pipelines and assessed
against expert-curated reference data.</p>
<p>This guide takes you through a complete workflow: configure LLM access, define an annotation task,
build and run a pipeline, evaluate its output, revise the Prompt, and test the revised version. It also
shows where the <a href="#agent-assistant">Agent Assistant</a> can help while keeping scientific
decisions under your review.</p>
<div class="docs-recommendation">
<span class="docs-recommendation-label">Recommended: work Agent-first</span>
<p>Use the <strong>Agent Assistant</strong> as you would use a coding agent: describe the scientific
task, name the data, define the required output, and ask it to propose the Prompt and pipeline. Continue
the conversation to inspect results, diagnose errors, and revise the Prompt. The Agent can make the
mechanical changes while you review the scientific assumptions, proposed operations, and actual
outputs.</p>
<p>The manual steps in this guide remain important: they show you what the Agent is building and how to
verify each part. If you prefer, you can perform every step directly on the canvas.</p>
</div>
<p>The worked example is <strong>gene–disease association extraction</strong>. For each abstract, the
pipeline identifies the gene–disease relations asserted by the authors, retains a supporting quotation,
and uses a short <a href="#process-node">Process</a> step to produce a tidy table. The output is then
compared with pairs reviewed by a curator. Generate steps use a model and Prompt; Process steps apply
explicit Python transformations. The same pattern can be adapted to literature screening, clinical
trial annotation, evidence synthesis, and other biomedical data-mining tasks.</p>
<div class="docs-flow" aria-label="Example pipeline"><span>Dataset<br><small>5 example abstracts</small></span><b>→</b><span>Generate<br><small>Extract associations</small></span><b>→</b><span>Process<br><small>Tidy and deduplicate</small></span><b>→</b><span>Structured output<br><small>Gene–disease pairs</small></span></div>
<p>The example uses five short, synthetic abstracts so that every intermediate result is easy to
inspect. Its scores demonstrate the workflow only; they are not evidence of performance on a research
corpus. For a real study, develop the pipeline on a small reviewed sample and reserve separate records
for final validation.</p>
<p>For a larger project to explore, open <a href="/gallery">Gallery</a>, select
<strong>Kinase–Substrate Evidence Curation</strong>, and use <strong>Add to my account</strong>.
You can also build the example yourself by following the steps below.</p>
"""),
        ("configure-model", "Configure LLM access", lambda: f"""
<p>AnnoBio uses model access that you provide. In the browser, register or sign in and open
<strong>Workspace</strong>. On desktop, launch the app and wait for its local backend to start. You can
configure a model before creating a project.</p>
<p>The desktop app starts its local backend automatically. If model, Process, or evaluation actions are
unavailable, open the bottom <strong>Log</strong> tab and confirm that the backend started successfully
before changing the workflow.</p>
<h3 id="add-your-model">Add and test a credential</h3>
<p>In the browser, select <strong>LLM settings</strong> in the top bar. On desktop, open
<strong>Settings → LLM settings…</strong>. Under <strong>Credentials</strong>, enter the provider,
Model ID, and API key, then select <strong>Test</strong>. Do not continue until the credential passes.
You can also connect an OpenRouter account. Credentials must be configured by you; the Agent Assistant
cannot add them.</p>
{fig("llm-settings", "Settings provides separate defaults for Generate, prompt optimization, and the Agent Assistant. Configure and test credentials before running a model task.")}
<p>Choose defaults for <strong>Generate</strong>, <strong>Optimize prompt</strong>, and
<strong>Agent Assistant</strong>; they may use different models. Record the provider and Model ID used
for each experiment, because model choice can affect reproducibility. You can override the default with
a tested model when creating a Generate or starting an optimization. Under
<strong>Optimize</strong>, also select the <strong>Default review method</strong> when more than one
method is installed.</p>
<p>Requests are sent to the provider you configure, and its usage charges and data-handling terms
apply. Do not submit identifiable or restricted data unless that use is permitted. Begin with a small
pilot sample to verify the instructions, schema, and model settings before processing the full corpus.</p>
<p><strong>Checkpoint:</strong> at least one credential should show a successful test, and Generate
should have a default model.</p>
"""),
        ("create-a-project", "Define the task and create a project", lambda: f"""
<p>Before building the workflow, state the unit of analysis and the expected output. In this example,
one input row is one abstract and one output row is one asserted gene–disease relation. Decide which
fields are required, what counts as a positive relation, and how uncertain or negated statements should
be handled. These decisions will guide the Dataset, Prompt, and reference annotations.</p>
<p>In the browser, create a project from the project picker in the top bar. On desktop, use
<strong>File → New project…</strong> and choose where to save the project file. Give the project a name
that identifies the research task. Its canvas will hold the data, Prompts, processing steps, results,
and execution history.</p>
{fig("empty-canvas", "Start with a project canvas. Add the Dataset and Prompt that your first Generate step will use.")}
<p><strong>Checkpoint:</strong> you should now have a named project with an empty canvas and a tested
default Generate model.</p>
"""),
        ("build-a-dataset", "Prepare the input Dataset", lambda: f"""
<p>Create a Dataset from the toolbar or, on desktop, from
<strong>Edit → Create new dataset</strong>. For this example, each row represents one abstract and the
columns are <code>ID</code>, <code>Title</code>, and <code>Abstract</code>. Keep a stable, unique
identifier in every research Dataset. It is needed to trace an output to its source and to pair model
outputs with reference annotations later.</p>
{fig("add-dataset-modal", "Choose how to create a Dataset: start with a table, import a file, or import records from a supported source.")}
<div class="docs-table-wrap"><table>
<thead><tr><th>Starting point</th><th>How to use it</th></tr></thead><tbody>
<tr><td>A few example records</td><td>Create an empty table, then add column names and rows in the Dataset editor.</td></tr>
<tr><td>An existing table</td><td>Import a spreadsheet, CSV/TSV, or JSON/JSONL file. Check the selected worksheet and parsed columns.</td></tr>
<tr><td>Literature or database IDs</td><td>Import from PubMed, ClinicalTrials.gov, bioRxiv/medRxiv, ChEMBL, Europe PMC, OpenAlex, or UniProt using the identifiers requested by that source.</td></tr>
<tr><td>Images or PDFs</td><td>Import files into Image or PDF columns. A compatible model receives those files when the column is mapped to a Prompt input.</td></tr>
</tbody></table></div>
{fig("dataset-table", "The example Dataset: five abstracts, each with an ID, a title, and the abstract text.")}
<p>Select the Dataset node to open it, then verify the import before building the pipeline. Confirm that one row
corresponds to the intended unit of analysis, identifiers are unique, text has not been truncated, and
file columns contain the expected files. Check missing values, duplicate records, worksheet selection,
column types, and unexpected parsing. Correcting these problems now prevents them from being mistaken
for model errors later. The <a href="#agent-assistant">Agent Assistant</a> can also search supported
external sources when you need to assemble a literature set.</p>
<p>Keep source data separate from manually reviewed reference answers. Once a saved History record
refers to a Dataset, it may become content-locked so that the recorded run remains reproducible. Create
a new Dataset version or an independent copy rather than altering a locked input.</p>
<p><strong>Checkpoint:</strong> the canvas should contain an inspected input Dataset with one stable ID
per source record.</p>
"""),
        ("agent-first", "Recommended: start with the Agent Assistant", lambda: """
<p>Once the source Dataset is ready, begin in the Agent Assistant rather than assembling every
downstream node manually. Open the Agent side bar and describe the task in the same way you would brief
a coding agent: identify the Dataset, define one input and output observation, list the required fields,
and state important inclusion, exclusion, and evidence rules.</p>
<h3>Ask the Agent to build the first version</h3>
<blockquote class="docs-request">Use the Dataset disease_abstracts. Read Title and Abstract and propose
a Prompt that returns one row per asserted gene–disease association, with gene, disease, and a short
supporting quotation. Exclude negated associations. Then propose a Generate step and map the Dataset
columns to the Prompt inputs. Show me all proposed changes before running anything.</blockquote>
<p>Review the proposed Prompt text, output schema, connections, and selected model. Ask follow-up
questions or request edits in natural language. Confirm the proposal only when it matches your
annotation protocol; approve model or code execution separately.</p>
<h3>Use the conversation to modify the Prompt</h3>
<p>After running and evaluating the pipeline, return to the Agent with the relevant node names and
observed failure pattern. Ask it to explain the evidence before proposing a change:</p>
<blockquote class="docs-request">Inspect the unmatched rows in Evaluate pairs. Separate nomenclature
errors from false positive relations, explain which Prompt instruction caused each pattern, and propose
a new Prompt version. Preserve the original Prompt and do not apply or run the revision until I review
it.</blockquote>
<p>This conversational loop—describe, inspect, revise, and verify—is the recommended way to work with
AnnoBio. The following chapters explain the Prompt, Generate, Process, and Evaluate objects in detail so
that you can review the Agent's work and intervene precisely. See
<a href="#agent-workflow">the full Agent workflow</a> for proposal and execution controls.</p>
<p><strong>Checkpoint:</strong> you should have either an Agent proposal for the first Prompt and
Generate step, or a clear reason to build them manually in the next chapters.</p>
"""),
        ("write-a-prompt", "Define the Prompt and output fields", lambda: f"""
<p>Create a Prompt from the toolbar or, on desktop, from
<strong>Edit → Create new prompt</strong>. Use a task-specific name, such as
<strong>Extract gene–disease pairs</strong>, so that later versions remain identifiable.</p>
<h3>Describe what to extract</h3>
<p>Translate the annotation protocol into explicit instructions. Define the target relation, inclusion
and exclusion criteria, treatment of negation and uncertainty, required evidence, and the behavior when
no eligible relation is present. Avoid relying on specialist assumptions that are not stated in the
Prompt. Use single-brace placeholders for values supplied by each input row:</p>
<pre class="docs-example">You are curating gene–disease associations from biomedical abstracts.

Title: {{title}}
Abstract: {{abstract}}

List every gene that the abstract reports as associated with a disease.
Return one row per gene–disease pair, with a short quote from the abstract as evidence.</pre>
<p>Each placeholder becomes a Prompt input that you will map to a Dataset column in Generate. Match
placeholder names exactly. This first Prompt is intentionally incomplete: it does not specify how to
represent alleles and variants or how to handle a negated association. The evaluation below makes those
failures visible.</p>
<h3>Choose the table you want back</h3>
<p>Define an output schema with stable field names, precise descriptions, representative examples, and
appropriate data types. The example returns <code>gene</code>, <code>disease</code>, and
<code>evidence</code>. Specify expected nomenclature—for example, an HGNC gene symbol rather than a
variant label. Enable <strong>Allow None</strong> only when a missing value is scientifically valid;
otherwise it can conceal an extraction failure.</p>
<p>Choose <strong>Multiple output rows</strong> when one input may yield zero, one, or several
observations, as in relation extraction. Choose <strong>One output row</strong> when every input should
produce one annotation, as in document-level classification. This decision determines the shape of the
results table and how it must later be evaluated.</p>
{fig("add-prompt-modal", "The Prompt window: placeholders become inputs on the left, and the output schema returns multiple gene–disease rows per abstract.")}
<p><strong>Checkpoint:</strong> the Prompt should have two inputs, <code>title</code> and
<code>abstract</code>, and a multiple-row schema with <code>gene</code>, <code>disease</code>, and
<code>evidence</code>.</p>
"""),
        ("connect-and-run", "Connect and run the first step", lambda: f"""
<ol>
<li>Open the Prompt, choose a tested model beside <strong>Create Generate</strong>, and create the
Generate step.</li>
<li>Drag from the Dataset <strong>Output</strong> port to <strong>Connect data</strong> on Generate.
Because this Generate was created from the Prompt, its Prompt connection is already present. If you
create an unconnected Generate instead, also connect the Prompt to <strong>Connect prompt</strong>.</li>
<li>Open Generate. Under <strong>Map input columns to prompt inputs</strong>, map
<code>Title</code> to <code>title</code> and <code>Abstract</code> to <code>abstract</code>.</li>
<li>Verify the connected Dataset, Prompt version, model, and every input mapping. For a first run, use
the five-row example or another small pilot sample.</li>
<li>Select <strong>Run</strong>. Keep the window open to monitor progress, then inspect the completed
results table.</li>
</ol>
{fig("canvas-connected", "The first pipeline: the Dataset supplies the abstracts and the Prompt supplies the instructions to Generate.")}
<p>Results appear as input rows complete. With a multiple-row schema, one abstract may yield several
output rows; here, the BRCA1 abstract yields two relations. Check coverage across input IDs, inspect
every output field, and open row details to examine the actual request and model response. During a
pilot, do not judge quality from the first plausible-looking rows.</p>
{fig("run-results", "Generate maps Dataset columns to Prompt inputs on the left; the results table shows seven pairs from five abstracts.")}
<p>Read the output against the source text before continuing. In this run,
<code>APOE ε4</code> and <code>LRRK2 G2019S</code> mix gene symbols with allele or variant labels, while
<code>CLU</code> is extracted from a sentence that explicitly reports no association. These are
different error types and should not be collapsed into a single accuracy judgment. The next sections
encode the expected answers and quantify the errors.</p>
<p>The node's <strong>History</strong> lets you revisit earlier attempts. If inputs change, an earlier
result may remain visible as <strong>Historical</strong>; run the current configuration before treating
it as the current output.</p>
<p><strong>Checkpoint:</strong> all five input IDs should have completed, and you should be able to
explain each suspicious output by returning to its source text and row details.</p>
"""),
        ("process-node", "Extend and manage the pipeline", lambda: f"""
<p>Add downstream steps when the research workflow requires more than one operation. For example, a
gene–disease pipeline might tidy the extracted columns, validate gene symbols against HGNC or UniProt,
and then use another Prompt to normalize disease mentions. Keep each step focused on one operation so
that its inputs, outputs, and failures remain interpretable.</p>
<h3>Use Process for table transformations</h3>
<p>Use Process for deterministic table transformations that should be explicit and reproducible:
selecting or renaming columns, filtering rows, joining tables, deduplicating records, or calculating
derived values. In the desktop app, first open <strong>Settings → Python settings…</strong>, select an
interpreter, and test it; the same setting is required for <strong>Match by code</strong> during
evaluation. Create a Process from a Dataset or step output and write
<code>def process(df):</code> to transform its pandas DataFrame. Return one DataFrame, or return a
dictionary of named DataFrames to create output branches. For additional inputs, add
<code>df_&lt;name&gt;</code> parameters and connect the corresponding input dots.</p>
{fig("process-node", "A Process reads the Generate output and keeps three tidy columns: paper, gene, and disease.")}
<p>Run the Process on a small input and inspect the output columns and row count before continuing.
Use a direct connection when the downstream step should always follow the current upstream result.
<strong>Save to workspace</strong> instead creates a Dataset snapshot for independent inspection,
editing, or reuse; downstream work from that snapshot will not automatically follow later upstream
runs.</p>
<h3>Choose how much to run</h3>
<div class="docs-table-wrap"><table>
<thead><tr><th>Action</th><th>What happens</th></tr></thead><tbody>
<tr><td>Run only this node</td><td>Runs this step afresh using available upstream results.</td></tr>
<tr><td>Resume pipeline to here</td><td>Reuses valid results, resumes compatible partial progress, and runs missing or outdated dependencies up to this step. If everything is current, it does no work.</td></tr>
<tr><td>Restart pipeline to here</td><td>Runs the required upstream steps and this step afresh. Review the plan before starting.</td></tr>
</tbody></table></div>
<p>The right-click menu shows the actions relevant to the node's current state. An interrupted
Generate may also offer <strong>Resume</strong> for that node alone. The bottom <strong>Run</strong>
tab records execution outcomes.</p>
<h3>Inspect the route</h3>
<p>Open the <strong>Pipeline</strong> tab and read the selected route from source Dataset to final
output. Select a step to locate it on the canvas. Where alternatives exist, choose the Prompt version
or Generate that belongs to the analysis you intend to run. Give the route an informative name, then
use <strong>Export Python Project</strong> when you need a standalone, inspectable representation of
that selected computational route.</p>
{fig("pipeline-overview", "The Pipeline panel below the canvas summarizes the connected steps: Generate, then the Process.")}
<p><strong>Checkpoint:</strong> the selected route should read Dataset → Generate → Process, and the
Process output should contain the expected columns and row count.</p>
"""),
        ("evaluate-results", "Evaluate the output against reference answers", lambda: f"""
<p>Evaluation requires an explicit reference standard. Create a separate
<strong>ground truth Dataset</strong> containing answers reviewed under a documented annotation
protocol. Include the source identifier needed to associate each answer with its input. In this
example, a curator records six expected relations for five abstracts in
<strong>Reviewed pairs</strong>, with <code>ID</code>, <code>Gene</code>, and <code>Disease</code>
columns.</p>
<p>For a research study, resolve ambiguous cases before scoring and, where feasible, measure agreement
between annotators. Keep the data used to revise the Prompt separate from a held-out validation set.
Evaluation cannot compensate for inconsistent reference labels.</p>
<ol>
<li>Open a completed Generate and click <strong>Create Evaluate</strong>.</li>
<li>On the canvas, drag the reference Dataset <strong>Output</strong> to
<strong>Connect ground truth</strong> on Evaluate. Ground truth is connected on the canvas rather than
selected from a dropdown in the Evaluate window.</li>
<li>Define input pairing so that predictions are compared only with answers from the same source. Here,
under <strong>Match by rules</strong>, use <strong>+ Add rule</strong> to require
<strong>Input: ID</strong> to equal <strong>Ground truth: ID</strong>.</li>
<li>Add output matching rules for every field required for a correct observation. Here, both gene and
disease must match. Review case sensitivity, normalization, and missing-value behavior.</li>
<li>Select <strong>Run</strong>, then inspect both the summary metrics and the row-level matches.</li>
</ol>
{fig("review-method-picker", "Evaluate pairs each output row with a reviewed answer from the same abstract. Four of seven rows match: precision 57%, recall 67%.")}
<p>Rules can combine conditions with <strong>AND</strong> and <strong>OR</strong>. Choose matching that
reflects the scientific meaning of the field rather than merely maximizing the score. Available options
include fuzzy and semantic text matching; HGNC for human genes; PubChem and ChEBI for compounds; RxNorm
for drug names; MeSH and MONDO for diseases or conditions; and GO for gene ontology terms. Use a
normalizer only when it is valid for the field and study protocol. Use
<strong>Match by code</strong> when the protocol requires custom logic, and preserve that code with the
project.</p>
<p>Interpret precision as the proportion of predicted relations that are correct, recall as the
proportion of reference relations recovered, and F1 as their harmonic mean. Always inspect the
comparison rows as well: the same score can result from scientifically different failures. Here,
<code>APOE ε4</code> and <code>LRRK2 G2019S</code> are nomenclature mismatches, while
<code>CLU</code> is a false positive caused by negation. Check pairing rules and reference labels before
attributing every mismatch to the Prompt.</p>
<p>The <strong>Optimize</strong> checkbox column controls which comparison rows contribute to the
displayed metrics and are sent to Prompt optimization. Keep all relevant rows selected for a complete
evaluation; use a subset only when that exclusion is intentional and documented.</p>
<p>Each Evaluate run has its own <strong>History</strong>. Changing its inputs or rules leaves the
previous result visible with an update notice; click Run to score the new configuration.</p>
<p><strong>Checkpoint:</strong> the example evaluation should pair outputs by <code>ID</code>, require
both gene and disease to match, and show four matched predictions out of seven.</p>
"""),
        ("review-and-optimize", "Optimize the Prompt from evaluation failures", lambda: f"""
<p>Optimize only after you have inspected the evaluation and confirmed that the reference data and
matching rules are sound. Confirm the <strong>Default review method</strong> under
<strong>LLM settings → Optimize</strong>. Then, from the completed Evaluate result, choose a tested
model beside <strong>Optimize prompt</strong> and start the analysis. The resulting Optimize node
records the method, analysis, and proposed changes for that specific evaluation attempt.</p>
<h3>Inspect the findings</h3>
<p>For each finding, examine the failed examples, the stated diagnosis, and the exact Prompt text that
would change. Decide whether the proposal expresses a general annotation rule or merely accommodates
the few development examples. Reject changes that weaken the evidence standard, introduce unsupported
domain assumptions, or conflict with the written annotation protocol.</p>
{fig("optimize-findings", "Issue analysis groups the failures by abstract: an allele and a variant name in the gene field, and a gene the abstract reports as not associated.")}
{fig("optimize-suggestion", "The suggested edit, accepted into the working Prompt: report the HGNC symbol only, keep variants in the evidence, and skip genes reported as not associated.")}
<h3>Verify before keeping a change</h3>
<p>Use <strong>Click to Verify</strong>, where offered, to test a suggestion on its associated
examples. This is a local check, not independent validation. For supported local edits, an unsuccessful
check may offer <strong>Click to Optimize</strong> to search for a better candidate. Available actions
depend on the selected method and suggestion state.</p>
<p>Use <strong>Accept</strong> to include a suggestion in the working Prompt, or
<strong>Revert</strong> to remove it. Click <strong>Apply</strong> to create a new Prompt version from
the selected changes. The source Prompt remains available for comparison.</p>
<p>An Optimize node stays tied to the Evaluate History it was created from. If you change the
reference answers, rules, or source result and run Evaluate again, start a new Optimize from that
new evaluation. Resume an interrupted Optimize when you want to continue the original analysis.</p>
<p><strong>Checkpoint:</strong> applying the accepted suggestion should create a new Prompt version;
the original Prompt and its evaluation must remain available.</p>
"""),
        ("compare-prompts", "Compare versions and check generalization", lambda: f"""
<ol>
<li>Open the new Prompt version and create a Generate using the same model, model settings, and input
Dataset as the baseline.</li>
<li>Run it and evaluate the output against the same development reference and matching rules.</li>
<li>Compare metrics, row-level failures, and previously correct examples. An improved aggregate score
can conceal a new systematic error.</li>
<li>Freeze the candidate Prompt, then evaluate it once on reviewed records that were not used for
Prompt development or optimization.</li>
</ol>
<p>The bottom <strong>Prompt</strong> tab shows Prompt families and their Evaluate &amp; Optimize
steps. Select a version's <strong>Compare</strong> icon to inspect changes from its predecessor. Select
the version you intend to use in the Pipeline route before exporting it.</p>
{fig("prompt-versions", "Version 2 of the Prompt runs through its own Generate and Evaluate. The Prompt panel below follows the family from the original through optimization to the new version.")}
<p>In the example, version 2 matches all six reviewed pairs. This is expected because the revision was
derived from those same five abstracts; the result is a development-set score, not an estimate of
generalization. Report performance on a separate validation set, including omissions, false positives,
and clinically or scientifically important subgroups. Retain the previous Prompt version and document
the model, Dataset versions, matching rules, and date of the final run.</p>
<p><strong>Checkpoint:</strong> you should have comparable baseline and revised runs, plus a plan to
evaluate the selected Prompt on held-out reviewed records.</p>
"""),
        ("agent-assistant", "What the Agent Assistant can do", lambda: """
<p>The Agent Assistant can inspect the open project and propose work through natural-language requests.
Treat it as an auditable research assistant rather than an autonomous decision maker: name the data and
nodes involved, define the expected output, state scientific constraints, and specify whether you want
an explanation, a proposal, or an execution. Review proposed changes and generated content before they
become part of the analysis.</p>
<div class="docs-table-wrap"><table class="docs-capabilities">
<thead><tr><th>Task</th><th>What it can do</th><th>Example request</th></tr></thead><tbody>
<tr><td>Understand a project</td><td>Inspect nodes, connections, Prompt text, schemas, input mappings, and available result rows.</td><td>“Explain this pipeline and identify any missing inputs. Do not change anything yet.”</td></tr>
<tr><td>Find and prepare data</td><td>Search supported external sources, propose imports, create or update Datasets, copy or version them, and configure sampling.</td><td>“Search PubMed for papers about LRRK2 and Parkinson’s disease. Show candidate records before importing them.”</td></tr>
<tr><td>Build a pipeline</td><td>Propose Prompts, Generate and Process steps, connections, and output schemas.</td><td>“Use disease_abstracts to extract gene and disease names with evidence text. Map Title and Abstract to the Prompt inputs.”</td></tr>
<tr><td>Transform tables</td><td>Draft Process code, try it on sample inputs, and propose the Process or a code change.</td><td>“Create a Process that keeps one row per gene–disease pair, with the paper ID.”</td></tr>
<tr><td>Run and inspect steps</td><td>Propose execution, resume a pipeline to a target, inspect results and supported task errors, and save outputs as Datasets.</td><td>“Resume the pipeline through this Generate, reusing valid upstream results. Then show the output rows.”</td></tr>
<tr><td>Evaluate results</td><td>Configure ground truth, pairing and grouped matching rules or matching code; run evaluation and inspect mismatches.</td><td>“Compare this Generate with Reviewed pairs. Pair rows by ID, check gene and disease, then explain unmatched rows.”</td></tr>
<tr><td>Improve a Prompt</td><td>Propose an optimization run, inspect findings, verify supported suggestions, and create a new Prompt version from changes.</td><td>“Inspect this Evaluate's failures and propose a targeted Prompt improvement. Keep the original version.”</td></tr>
<tr><td>Organize work</td><td>Rename nodes and pipelines, select History records, and propose Python export of a pipeline.</td><td>“Rename this pipeline Gene–disease curation and prepare its Python export.”</td></tr>
</tbody></table></div>
<p>Source searches cover supported biomedical and literature services, plus Wikipedia when explicitly
requested. They are source-specific queries rather than general web browsing. Record the query,
filters, and retrieval date when search results contribute to a review corpus. For troubleshooting,
the Agent can inspect exposed node and task information, but it cannot read the desktop Log panel.</p>
"""),
        ("agent-workflow", "Give a task, review the proposal, check the result", lambda: f"""
<p>Use the side-bar button in the top bar (labelled <strong>Toggle Agent Side Bar</strong>) to open the
<strong>Agent Assistant</strong>, then choose or add a conversation. It uses the Agent model configured
in LLM settings. In the browser, open a project before using it.</p>
<h3>1. Describe a concrete task</h3>
<p>Name the relevant Dataset or node, define the unit of analysis and output fields, and state
inclusion, exclusion, and evidence requirements. Ask the Agent to show its proposed structure before
running a model or changing project content. For example:</p>
<blockquote class="docs-request">Use disease_abstracts to extract gene–disease pairs. Read Title and
Abstract and return gene, disease, and a short evidence quote. One abstract may contain several pairs.
Show me the proposed nodes before running anything.</blockquote>
{fig("agent-assistant", "The Agent answers with a plan: the Prompt and Generate it would add, and how it would map the columns. Nothing changes until you confirm.")}
<h3>2. Inspect the proposed changes</h3>
<p>The Agent can read project information to plan its work. Changes to project content are presented
as proposals for you to review and confirm. Check the affected nodes, Prompt wording, schema, input
mappings, connections, and model selection against your protocol. Ask for a revision when a proposal
changes the scientific meaning of the task or leaves a decision implicit.</p>
<h3>3. Confirm execution separately</h3>
<p>Model and code jobs use execution cards. Review the target and scope before starting. A proposal
to create a step and a request to run that step are different actions. When several tested models are
available, state your choice or answer the Agent's model question.</p>
<h3>4. Check the actual output</h3>
<p>Open the created nodes and inspect their actual inputs, configuration, and results. Confirm record
counts and review representative outputs against their sources. For optimization, inspect the new
Prompt version and evaluate it as described above. If a job stops or fails, ask the Agent to inspect
its state before retrying. A proposal, accepted change, and completed execution are distinct events.</p>
<p>Configure provider credentials, default settings, and Python yourself. Use the interface to select
Pipeline routes, publish to Gallery, open or merge projects, and perform other actions the Agent does
not expose. The Agent respects the same content locks as the canvas.</p>
"""),
        ("agent-files", "Desktop: use attachments and local folders", lambda: """
<p><strong>These features are available in the desktop app.</strong> Use them when the source material
is a local table, document collection, or existing analysis project. Review institutional data policies
before attaching sensitive, unpublished, or identifiable material.</p>
<ul>
<li><strong>Attach files:</strong> use the paperclip beside Send, or drag files into the conversation.
The Agent can inspect attached tables and read supported text, code, and document content. Ask it
to import a table, or a batch of images or PDFs, as a Dataset in the open project.</li>
<li><strong>Provide a path:</strong> include a file or folder path in your message, or drag in a folder.
Sending that path grants read access for this conversation. An additional folder request appears
as an <strong>Allow / Deny</strong> card.</li>
<li><strong>Adapt an existing project:</strong> ask it to inspect the README, data format, and relevant
processing code, then propose how to reproduce that workflow with Datasets, Process steps, and Prompts.</li>
</ul>
<p>Local access is read-only and limited to paths you provide or approve. The Agent can adapt code into
a proposed Process; it cannot modify source files or execute the original project's scripts. Inspect
the proposed Process before running it. Only share content that your ethics approval, data-use
agreement, and configured model provider permit you to transmit.</p>
<p>Supported inputs include common spreadsheets and JSON/JSONL, text and code files, and readable
text from PDF, Word, PowerPoint, and OpenDocument documents. Image attachments can be imported into
a Dataset; attachment inspection alone does not interpret their visual contents. Use a compatible
Generate model for image annotation.</p>
<p>For a large folder, identify the entry point and relevant files first. A conversation can read or
search the contents of up to 100 distinct local path files; a folder import supports up to 500 files
and 512 MB. A project must be open before importing a Dataset. On desktop, the Agent can also propose
creating a project when none is open; you choose the save location.</p>
"""),
        ("key-concepts", "Objects at a glance", lambda: """
<div class="docs-table-wrap"><table>
<thead><tr><th>Object</th><th>Purpose</th></tr></thead><tbody>
<tr><td>Project</td><td>The saved canvas, its data, prompts, conversations, and execution history.</td></tr>
<tr><td>Dataset</td><td>A table of source records or reviewed reference answers, with Text, Image, or PDF columns.</td></tr>
<tr><td>Prompt</td><td>Reusable instructions, input placeholders, and a structured output schema.</td></tr>
<tr><td>Generate</td><td>Applies a Prompt and selected model to rows from one connected data source.</td></tr>
<tr><td>Process</td><td>Runs a Python DataFrame transformation, optionally with several inputs or output branches.</td></tr>
<tr><td>Sample</td><td>Selects subsets of a Dataset according to its sampling settings.</td></tr>
<tr><td>Evaluate</td><td>Pairs outputs with reference answers, applies matching rules or code, and saves scored attempts.</td></tr>
<tr><td>Optimize</td><td>Analyzes one evaluation attempt and proposes changes to its source Prompt.</td></tr>
<tr><td>History</td><td>Saved attempts and their input configurations, so previous results remain inspectable.</td></tr>
</tbody></table></div>
"""),
        ("optimization-methods", "Optimization methods", lambda: """
<p>Under <strong>LLM settings → Optimize</strong>, the
<strong>Default review method</strong> control lists the optimization methods installed on your
instance; it appears when more than one method is available. Begin with the default when you want
interpretable, issue-guided edits. Use another method only when its search strategy, computational
cost, and use of examples fit the study design.</p>
<div class="docs-table-wrap"><table>
<thead><tr><th>Method</th><th>What it changes</th></tr></thead><tbody>
<tr><td>Thompson Prompt Search</td><td>Analyzes failures and proposes local instruction edits; supported edits can undergo further local search.</td></tr>
<tr><td>GEPA</td><td>Reflective evolution of candidate instructions.</td></tr>
<tr><td>MIPROv2</td><td>Instruction and few-shot example search.</td></tr>
<tr><td>COPRO</td><td>Instruction-only search.</td></tr>
<tr><td>BootstrapFewShotWithRandomSearch</td><td>Few-shot example selection.</td></tr>
<tr><td>SIMBA</td><td>Self-reflective rules and few-shot examples.</td></tr>
<tr><td>TextGrad</td><td>Textual-gradient instruction updates; available only with its optional dependency installed.</td></tr>
</tbody></table></div>
<p>Methods differ in search strategy, model usage, number of calls, and available suggestion actions.
Optimization can be substantially more expensive than a single Generate run. Regardless of method,
inspect the resulting Prompt and evaluate it on reviewed data that were not used to drive the search.</p>
"""),
        ("managing-projects", "Save, reuse, and share your work", lambda: """
<p>Browser projects are saved to your account; use the project picker to reopen, duplicate, or merge
them. Desktop projects are local project files; use <strong>File</strong> to open one,
<strong>Save as…</strong>, or merge another project.</p>
<p>Duplicate a project before an independent experiment or major methodological change. Merge only
when you intend to bring another project's nodes onto the current canvas. Use History to inspect prior
attempts, and create new Prompt or Dataset versions whenever the original configuration must remain
recoverable.</p>
<p>Use the Pipeline panel's Python export for a selected computational route. Use
<strong>Publish to Gallery</strong> to submit a project for public reuse; submissions are reviewed
before appearing in the public Gallery. Browser users must first add their name in
<strong>Profile</strong>. Before export or publication, remove restricted data and credentials, check
Prompt and Dataset versions, and inspect results and conversation content. Record the model identifiers
and reference-data provenance needed to interpret or reproduce the workflow.</p>
<p id="website-overview">Return to <a href="#create-a-project">pipeline setup</a>,
<a href="#evaluate-results">evaluation and optimization</a>, or
<a href="#agent-assistant">Agent capabilities</a> as you continue your work.</p>
"""),
    ]
