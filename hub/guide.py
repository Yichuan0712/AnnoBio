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
<p>AnnoBio helps you turn biomedical records into structured annotations, evaluate those annotations,
and improve the prompts that produced them. This guide follows three tasks: <a href="#create-a-project">build
a pipeline</a>, <a href="#evaluate-results">evaluate and optimize a prompt</a>, and
<a href="#agent-assistant">use the Agent Assistant</a> to help with that work.</p>
<p>The running example is <strong>gene–disease association extraction</strong>: read an abstract's title
and text, list each gene the abstract links to a disease, and compare the result with pairs a curator has
already reviewed. The same workflow applies to document classification, clinical trial annotation, and
other extraction tasks.</p>
<div class="docs-flow" aria-label="Example pipeline"><span>Dataset<br><small>5 abstracts</small></span><b>→</b><span>Generate<br><small>uses a Prompt</small></span><b>→</b><span>Gene–disease pairs</span></div>
<p>Evaluation adds a feedback loop: compare results with a reference Dataset, inspect failures, optimize
the Prompt, and run a new version. The five short abstracts in the screenshots were written for this
guide; their scores only illustrate the controls.</p>
<p>For a larger project to explore, open <a href="/gallery">Gallery</a>, select
<strong>Kinase–Substrate Evidence Curation</strong>, and use <strong>Add to my account</strong>.
You can also build the example yourself by following the steps below.</p>
"""),
        ("create-a-project", "Create a project and choose a model", lambda: f"""
<p>Open <strong>Workspace</strong> and create a project for your annotation task. In the browser, use
the project picker in the top bar. On desktop, use <strong>File → New project…</strong> and choose where
to save the project file. The canvas holds your datasets, prompts, processing steps, and results.</p>
{fig("empty-canvas", "Start with a project canvas. Add the Dataset and Prompt that your first Generate step will use.")}
<h3 id="add-your-model">Add your model</h3>
<p>Open <strong>Settings</strong> and add a model under <strong>Credentials</strong>. Supply its Model ID
and provider API key, then use <strong>Test</strong> to check the connection. You can also connect an
OpenRouter account. Configure credentials yourself in Settings.</p>
{fig("llm-settings", "Settings provides separate defaults for Generate, prompt optimization, and the Agent Assistant. Configure and test credentials before running a model task.")}
<p>Set the defaults for <strong>Generate</strong>, <strong>Optimize prompt</strong>, and
<strong>Agent Assistant</strong>. They can use different models. When creating a Generate or starting an
optimization, you can select a tested model beside the action button.</p>
<p>You bring your own model access. Requests use your configured provider, and that provider's usage
charges apply. Start with a few rows to check the prompt, output format, and settings before a larger run.</p>
"""),
        ("build-a-dataset", "Prepare the input Dataset", lambda: f"""
<p>Create a Dataset from the toolbar or <strong>Edit → Create new dataset</strong> on desktop.
For this example, each row is an abstract, with <code>ID</code>, <code>Title</code>, and
<code>Abstract</code> columns. Keep an identifier so you can trace an extracted pair back to its source.</p>
{fig("add-dataset-modal", "Choose how to create a Dataset: start with a table, import a file, or import records from a supported source.")}
<div class="docs-table-wrap"><table>
<thead><tr><th>Starting point</th><th>How to use it</th></tr></thead><tbody>
<tr><td>A few example records</td><td>Create an empty table, then add column names and rows in the Dataset editor.</td></tr>
<tr><td>An existing table</td><td>Import a spreadsheet, CSV/TSV, or JSON/JSONL file. Check the selected worksheet and parsed columns.</td></tr>
<tr><td>Literature or database IDs</td><td>Import from PubMed, ClinicalTrials.gov, bioRxiv/medRxiv, ChEMBL, Europe PMC, OpenAlex, or UniProt using the identifiers requested by that source.</td></tr>
<tr><td>Images or PDFs</td><td>Import files into Image or PDF columns. A compatible model receives those files when the column is mapped to a Prompt input.</td></tr>
</tbody></table></div>
{fig("dataset-table", "The example Dataset: five abstracts, each with an ID, a title, and the abstract text.")}
<p>Double-click the Dataset to inspect its contents. Check for missing abstracts, duplicate records, and
unexpected column names. Keyword searching of external sources is also available through the
<a href="#agent-assistant">Agent Assistant</a>.</p>
<p>A Dataset used by saved results can become content-locked to preserve those results' inputs.
Create a new Dataset version or an independent copy when you need to change locked data.</p>
"""),
        ("write-a-prompt", "Define the Prompt and output fields", lambda: f"""
<p>Create a Prompt from the toolbar or <strong>Edit → Create new prompt</strong> on desktop.
Give it a task-specific name, such as <strong>Extract gene–disease pairs</strong>.</p>
<h3>Describe what to extract</h3>
<p>Write instructions that say what to include, what to leave out, and what to return. Use
single-brace placeholders for the values that change with each input row:</p>
<pre class="docs-example">You are curating gene–disease associations from biomedical abstracts.

Title: {{title}}
Abstract: {{abstract}}

List every gene that the abstract reports as associated with a disease.
Return one row per gene–disease pair, with a short quote from the abstract as evidence.</pre>
<p>Each placeholder becomes a Prompt input; you map it to a Dataset column when configuring Generate.
This first version is deliberately short, and the evaluation below shows where it falls short.</p>
<h3>Choose the table you want back</h3>
<p>Define an output schema with named fields, descriptions, examples, and appropriate types. The
example returns <code>gene</code>, <code>disease</code>, and <code>evidence</code>. Set
<strong>Allow None</strong> where an answer can legitimately be missing.</p>
<p>Choose <strong>multiple rows</strong> when one input can contain several answers, as here, where one
abstract can link a gene to two diseases. Choose <strong>a single row</strong> when each input should
have exactly one annotation. The choice controls the shape of the results table.</p>
{fig("add-prompt-modal", "The Prompt window: placeholders become inputs on the left, and the output schema returns multiple gene–disease rows per abstract.")}
"""),
        ("connect-and-run", "Connect and run the first step", lambda: f"""
<ol>
<li>Open the Prompt, select a tested model beside <strong>Create Generate</strong>, and create the step.</li>
<li>Connect the Dataset's output dot to Generate's data input. The Prompt connects to Generate's Prompt input.</li>
<li>Open Generate. Under <strong>Map input columns to prompt inputs</strong>, map
<code>Title</code> to <code>title</code> and <code>Abstract</code> to <code>abstract</code>.</li>
<li>Check the input mapping and model, then click <strong>Run</strong>.</li>
</ol>
{fig("canvas-connected", "The first pipeline: the Dataset supplies the abstracts and the Prompt supplies the instructions to Generate.")}
<p>Results appear as rows complete. With a multiple-row schema, one abstract may produce several output
rows: here the BRCA1 abstract yields two pairs. Inspect the extracted fields and use a row's details to
examine the actual request and response.</p>
{fig("run-results", "Generate maps Dataset columns to Prompt inputs on the left; the results table shows seven pairs from five abstracts.")}
<p>Read the output critically before going further. In this run the model wrote <code>APOE ε4</code>
and <code>LRRK2 G2019S</code> in the gene field, and listed <code>CLU</code> even though its abstract
reports no association. The next sections measure and fix those mistakes.</p>
<p>The node's <strong>History</strong> lets you revisit earlier attempts. If inputs change, an earlier
result may remain visible as <strong>Historical</strong>; run the current configuration before treating
it as the current output.</p>
"""),
        ("process-node", "Extend and manage the pipeline", lambda: f"""
<p>Build a longer pipeline by connecting a Generate or Process output directly to another step.
For gene–disease curation, you might tidy the extracted columns, look each gene up in HGNC or UniProt,
then use another Prompt to normalize disease names.</p>
<h3>Use Process for table transformations</h3>
<p>Create a Process from a Dataset or step output. Write <code>def process(df):</code> to transform
its pandas DataFrame. Return one DataFrame, or a dictionary of named DataFrames to create branches.
For additional inputs, add <code>df_&lt;name&gt;</code> parameters and connect their input dots.</p>
{fig("process-node", "A Process reads the Generate output and keeps three tidy columns: paper, gene, and disease.")}
<p>Use a direct connection when the downstream step should follow upstream results.
<strong>Save to workspace</strong> creates a separate Dataset snapshot for editing or reuse; a step
reading that snapshot starts from the saved Dataset.</p>
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
<p>Open the <strong>Pipeline</strong> tab to follow connected Generate and Process steps. Click a step
to locate it on the canvas. Where alternatives exist, select the Prompt version or Generate for the
route you want. Click the pipeline's name to rename it, and use <strong>Export Python Project</strong>
to export the selected route as a standalone Python project.</p>
{fig("pipeline-overview", "The Pipeline panel below the canvas summarizes the connected steps: Generate, then the Process.")}
"""),
        ("evaluate-results", "Evaluate the output against reference answers", lambda: f"""
<p>Before optimizing a Prompt, define what a correct answer looks like. Create a separate
<strong>ground truth Dataset</strong> containing reviewed answers and a way to associate them with
their source inputs. For this example, a curator lists the expected pairs in a Dataset named
<strong>Reviewed pairs</strong>, with <code>ID</code>, <code>Gene</code>, and <code>Disease</code>
columns: six pairs for the five abstracts.</p>
<ol>
<li>Open a completed Generate and click <strong>Create Evaluate</strong>.</li>
<li>Connect or select the reference Dataset as ground truth.</li>
<li>Define input pairing so results are compared with answers from the same source, here
<strong>Input: ID</strong> equals <strong>Ground truth: ID</strong>.</li>
<li>Add output matching rules for the fields that define correctness, here gene and disease, then click
<strong>Run</strong>.</li>
</ol>
{fig("review-method-picker", "Evaluate pairs each output row with a reviewed answer from the same abstract. Four of seven rows match: precision 57%, recall 67%.")}
<p>Rules can combine conditions with <strong>AND</strong> and <strong>OR</strong>. Use appropriate
string or numeric matching. Biomedical name matching includes HGNC for human genes, PubChem for
compounds, and supported ontologies; select it only when it fits the field. Use
<strong>Match by code</strong> for custom matching logic.</p>
<p>Read precision, recall, and F1 together with the comparison rows. A missed pair, an extra pair,
and a name mismatch call for different changes. In the example, <code>APOE ε4</code> and
<code>LRRK2 G2019S</code> are name mismatches, and <code>CLU</code> is an extra pair. Check reference
labels and pairing rules before assuming every mismatch is a Prompt failure.</p>
<p>Each Evaluate run has its own <strong>History</strong>. Changing its inputs or rules leaves the
previous result visible with an update notice; click Run to score the new configuration.</p>
"""),
        ("review-and-optimize", "Optimize the Prompt from evaluation failures", lambda: f"""
<p>Use a completed Evaluate result as the starting point. Choose an available optimization method
and tested model, then click <strong>Optimize prompt</strong>. An Optimize node records the analysis
and proposed changes for that evaluation attempt. The model selector and <strong>Optimize prompt</strong>
button sit at the bottom right of the Evaluate window shown above.</p>
<h3>Inspect the findings</h3>
<p>Read which examples failed, why a change is proposed, and what text it changes. Check that a
suggestion preserves your intended evidence standard rather than just fitting the reference rows.</p>
{fig("optimize-findings", "Issue analysis groups the failures by abstract: an allele and a variant name in the gene field, and a gene the abstract reports as not associated.")}
{fig("optimize-suggestion", "The suggested edit, accepted into the working Prompt: report the HGNC symbol only, keep variants in the evidence, and skip genes reported as not associated.")}
<h3>Verify before keeping a change</h3>
<p>Use <strong>Click to Verify</strong> where offered to test a suggestion on its associated examples.
For supported local edits, an unsuccessful check may offer <strong>Click to Optimize</strong> to search
for a better candidate. Available actions depend on the method and the suggestion's state.</p>
<p>Use <strong>Accept</strong> to include a suggestion in the working Prompt, or
<strong>Revert</strong> to remove it. Click <strong>Apply</strong> to create a new Prompt version from
the selected changes. The source Prompt remains available for comparison.</p>
<p>An Optimize node stays tied to the Evaluate History it was created from. If you change the
reference answers, rules, or source result and run Evaluate again, start a new Optimize from that
new evaluation. Resume an interrupted Optimize when you want to continue the original analysis.</p>
"""),
        ("compare-prompts", "Compare versions and check generalization", lambda: f"""
<ol>
<li>Open the new Prompt version and create a Generate using the same model and input Dataset as the baseline.</li>
<li>Run it, then evaluate its output against the same reference answers and matching rules.</li>
<li>Compare scores and individual failures, including examples that were previously correct.</li>
<li>Check the revised Prompt on additional reviewed inputs that were not used to optimize it.</li>
</ol>
<p>The bottom <strong>Prompt</strong> tab shows Prompt families and their Evaluate &amp; Optimize
steps. Use <strong>Compare</strong> on a version to inspect changes from its predecessor. Select the
version you intend to use in the Pipeline route before exporting it.</p>
{fig("prompt-versions", "Version 2 of the Prompt runs through its own Generate and Evaluate. The Prompt panel below follows the family from the original through optimization to the new version.")}
<p>In the example, version 2 matches all six reviewed pairs. That is expected: the edit was written from
these same five abstracts. Verification on the examples behind a suggestion checks that local change; it does not establish
performance on unseen papers. Keep a separate validation set, check omissions and unsupported
relationships, and retain the previous version if the new one does not meet your criteria.</p>
"""),
        ("agent-assistant", "What the Agent Assistant can do", lambda: """
<p>The Agent Assistant works with the open project through natural-language requests. Start with
the task you want help with, the nodes or data involved, and what a successful result should look like.</p>
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
<p>Source searches cover the supported biomedical and literature services, plus Wikipedia when
requested. This is source-specific search rather than general web browsing. For troubleshooting,
the Agent can inspect exposed node and task information; it cannot read the desktop Log panel.</p>
"""),
        ("agent-workflow", "Give a task, review the proposal, check the result", lambda: f"""
<p>Open the <strong>Agent Assistant</strong> from the top bar and choose or add a conversation. It uses
the Agent model configured in Settings. In the browser, open a project before using it.</p>
<h3>1. Describe a concrete task</h3>
<p>Name the relevant Dataset or node, list the output fields, and state important constraints.
For example:</p>
<blockquote class="docs-request">Use disease_abstracts to extract gene–disease pairs. Read Title and
Abstract and return gene, disease, and a short evidence quote. One abstract may contain several pairs.
Show me the proposed nodes before running anything.</blockquote>
{fig("agent-assistant", "The Agent answers with a plan: the Prompt and Generate it would add, and how it would map the columns. Nothing changes until you confirm.")}
<h3>2. Inspect the proposed changes</h3>
<p>The Agent can read project information to plan its work. Changes to project content are presented
as proposals for you to review and confirm. Check the affected nodes, Prompt wording, output fields,
connections, and model selection. Ask for a revision when something differs from your task.</p>
<h3>3. Confirm execution separately</h3>
<p>Model and code jobs use execution cards. Review the target and scope before starting. A proposal
to create a step and a request to run that step are different actions. When several tested models are
available, state your choice or answer the Agent's model question.</p>
<h3>4. Check the actual output</h3>
<p>Open the created nodes and inspect their inputs and results. For optimization, inspect the new
Prompt version and evaluate it as described above. If a job stops or fails, have the Agent inspect its
state before retrying. A proposed operation is not a completed run.</p>
<p>Configure provider credentials, default settings, and Python yourself. Use the interface to select
Pipeline routes, publish to Gallery, open or merge projects, and perform other actions the Agent does
not expose. The Agent respects the same content locks as the canvas.</p>
"""),
        ("agent-files", "Desktop: use attachments and local folders", lambda: """
<p><strong>These features are available in the desktop app.</strong> Use them when your starting point
is a local table, document collection, or an existing analysis project.</p>
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
<p>Local access is read-only and limited to the paths you provide or allow. The Agent can adapt code
into a proposed Process; it cannot modify source files or execute the original project's scripts.
Only share files you intend the configured model provider to receive.</p>
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
<p>The method menu lists the methods installed on your instance. Start with the default to inspect
issue-guided edits, then choose another method when its search approach fits your task.</p>
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
<p>Methods differ in their stages, model usage, and available suggestion actions. An optimization
can make several model calls. Evaluate the resulting version on your own reviewed data.</p>
"""),
        ("managing-projects", "Save, reuse, and share your work", lambda: """
<p>Browser projects are saved to your account; use the project picker to reopen, duplicate, or merge
them. Desktop projects are local project files: use File to open, save a copy, or merge another project.</p>
<p>Duplicate a project for an independent experiment. Merge when you want another project's nodes
on the current canvas. Use History to inspect prior attempts within a project, and new Prompt or
Dataset versions when preserving the original configuration matters.</p>
<p>Use the Pipeline panel's Python export for a selected computational route. Use
<strong>Publish to Gallery</strong> when you want to submit a project for public reuse; submissions
require review before appearing in the public Gallery. Check the prompts, datasets, results, and
conversation content before sharing a project.</p>
<p id="website-overview">Return to <a href="#create-a-project">pipeline setup</a>,
<a href="#evaluate-results">evaluation and optimization</a>, or
<a href="#agent-assistant">Agent capabilities</a> as you continue your work.</p>
"""),
    ]
