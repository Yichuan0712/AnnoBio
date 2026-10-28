/**
 * The Agent's tools: OpenAI-format definitions sent with every turn, and their executors, which run
 * here in the renderer against the live canvas. ask_user is defined here but handled by the loop,
 * since answering it takes the user, not code.
 */
import { REFERENCE_DATABASES } from '../../databaseCatalog.js';
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { nodeTitle, readNodeRows, traceRunRow } from '../canvas/workflowNodeInspector.js';
import { loadSources } from '../operations/proposals.js';
import { previewTableRows } from '../execution/runJobs.js';
import { runProcessCode } from '../../processRunClient.js';
import { FILTER_OPERATORS, snapshotSchema, sourceJob, sourceOptions } from '../operations/sourceImports.js';
import { processTrialInputs } from '../canvas/processTrialInputs.js';

const MAX_TOOL_RESULT_CHARS = 24000;

export const ASK_USER_TOOL = 'ask_user';
export const PROPOSE_CHANGES_TOOL = 'propose_changes';
export const RUN_NODES_TOOL = 'run_nodes';
export const PIPELINE_ACTION_TOOL = 'pipeline_action';
export const CREATE_PROJECT_TOOL = 'create_project';
export const REQUEST_FOLDER_ACCESS_TOOL = 'request_folder_access';

/** Tools answered by the user rather than by code; calling one ends the loop until they respond. */
export const USER_TOOLS = new Set([ASK_USER_TOOL, PROPOSE_CHANGES_TOOL, RUN_NODES_TOOL, PIPELINE_ACTION_TOOL, CREATE_PROJECT_TOOL, REQUEST_FOLDER_ACCESS_TOOL]);

const GUIDE_TOPICS = [
  'pipeline-building',
  'process-code',
  'prompt-design',
  'evaluation',
  'prompt-optimization',
  'export-and-share',
  'dataset-editing',
  'reproduce-project',
];

function tool(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

const NODE_ID = { type: 'string', description: 'Exact node id from the workspace summary.' };
const START_ROW = { type: 'integer', minimum: 1, description: '1-based first row. Default 1.' };
const MAX_ROWS = { type: 'integer', minimum: 1, maximum: 50, description: 'Rows to return, at most 50. Default 5.' };

const PROPOSE_CHANGES_OPS = ['add_dataset', 'duplicate_dataset', 'move_image', 'download_dataset', 'import_dataset', 'add_sampler', 'sample_dataset', 'add_process', 'duplicate_process', 'add_prompt', 'add_prompt_version', 'add_run', 'add_score', 'save_run_results', 'save_process_output', 'save_score_results', 'apply_review', 'update', 'connect', 'disconnect', 'select_history', 'delete_history', 'remove'];

// Only where the chat takes attachments (the desktop app, docs/design/AGENT_ATTACHMENTS_PLAN.md).
const IMPORT_ATTACHMENT_OPERATION = '- import_attachment: ref, attachments (ids from the attachment previews, such as ["a1"]), OR folder (authorized folder id f1) + either files (relative paths) or pattern (glob), name?, note?, sheet? (a workbook sheet; default the first). One table attachment, including JSON/JSONL, becomes a text Dataset; a batch of image attachments, or of PDF attachments, becomes a Dataset with a Filename column and an Image (or PDF) column, one row per file, and the files are copied into the project when the proposal is applied. Document, text and code attachments are read-only; read their text and use add_dataset for structured records. Tables, images and PDFs cannot be mixed in one operation. Folder imports freeze the previewed file list and require a new proposal if it changes; at most 500 files / 512 MB.\n';

/** propose_changes, with import_attachment where the chat takes attachments. */
function proposeChangesTool({ attachments = false } = {}) {
  return tool(
    PROPOSE_CHANGES_TOOL,
    `Propose changes to the canvas. The user sees each change on a card and applies or rejects the whole proposal; nothing changes before that. The result tells you whether it was applied and the ids of added nodes. Put related changes in one proposal (a new prompt version with its run and score, for example). Only remove nodes the user asked to remove.

Reference existing nodes by id. A node added earlier in the same proposal is referenced by the "ref" you gave it, which must start with "$".

Operations ("op" plus the fields listed):
- add_dataset: ref, name, note?, columns (names, or {name, type: text | image | pdf}), rows (lists of cells, or objects keyed by column). Image/PDF cells reuse existing uploaded asset cells from read_rows; null is an empty cell. It cannot upload new local files or invent asset IDs.
- duplicate_dataset: ref, dataset, name?, note?, as_version? (default false). Copies the complete table including image/PDF cells. as_version links a new editable version and keeps row identities; an ordinary duplicate is standalone. Neither consumes another Sample pull.
- move_image: dataset, from_row, from_column, to_row, to_column, image? (1-based image within the source cell, default 1). Moves that image to the end of the target image cell in the same Dataset, removing it from the source, like dragging an image in the table. Row numbers are 1-based; both columns must be image columns and the Dataset must be editable.
- download_dataset: source and dataset (exact filename from inspect_source, desktop snapshots only). Downloads the shared source file only when the user applies this proposal; does not create a canvas node. Inspect its columns after the download completes before proposing an import.
- import_dataset: ref, source (pubmed | clinicaltrials | chembl | preprint | ${REFERENCE_DATABASES.filter((s) => s.kind !== 'snapshot').map((s) => s.source).join(' | ')} | wikipedia, or a desktop snapshot source from inspect_source), ids (omit for snapshots), fields (exact keys from inspect_source or search_source), name, note?, options?. Snapshot options: dataset (exact filename), limit (1-5000, default 5000), filters. Other sources accept their inspected connection options and filters when row_filters=true. filters is an array of up to 10 AND conditions: {column, op: equals | not_equals | contains | in | gt | gte | lt | lte | is_empty | not_empty, value?, values? (for in), case_sensitive? (default false)}. Filtering happens before the snapshot row cap. Credentials must be configured outside the conversation. The proposal shows filters; applied nodes preserve source file, filters and any truncation in their descriptions. Records are fetched only when applied. PubMed, ClinicalTrials.gov, ChEMBL and preprint use native search-query filters, not options.filters.
${attachments ? IMPORT_ATTACHMENT_OPERATION : ''}- add_sampler: ref (the Sample), dataset_ref? (the sampled Dataset), source (dataset), sampling? (random | random_with_replacement | rows), size + size_unit (rows | percent) for random, rows ("1 3 5-10") for rows, name?, dataset_name?, create_dataset? (default true). With create_dataset false, only adds a configurable Sample node; defaults are random without replacement, 100 percent. Once it has an output Dataset its settings lock.
- sample_dataset: ref (new Dataset), sampler (an existing Sample), name?, note?. Draws again using its saved settings. Random without replacement consumes unused source rows across pulls and fails when a full pull no longer fits; specified rows and replacement sampling are repeatable. inspect_node reports settingsLocked, outputs and finite progress (completed, total, remaining).
- add_process: ref, name?, primary_input? (a dataset, run or process: df in the code), primary_branch (only for a process with several branches), code? defining process(df, ...); every other input (a dataset or a step output) is a parameter after df named after its df_<alias> (inspect_node on a process lists them under availableInputs; see the process-code guide). Without primary_input, creates an unconnected Process whose code can be edited before connecting its Data input; default code returns df. Not run until the user runs it.
- duplicate_process: ref, process, name?. Copies a Process's code and detected outputs into a standalone Process with no inputs or results, like Duplicate this process.
- add_prompt: ref, name, note?, text (the prompt, with a {variable} for each input; {{ and }} write literal braces; an input has no type: mapped to an image or PDF column it sends those files), output {return_shape: single | table, fields [{key, type: str | float | list_str | list_float, description, examples?, allow_none? (boolean)}]}. Numeric examples are numbers; each list example is an array. allow_none corresponds to Allow None in the field editor. Field names must be unique (case-insensitive).
- add_prompt_version: ref, prompt (source), name?, and what to change: text_edits [{old, new}] (each old is text that appears exactly once in the prompt; replaced in order) or text (the complete new prompt), output (only what changes: {return_shape} alone keeps the fields), note. Everything else is copied. Prefer this over editing a prompt that already has runs.
- add_run: ref, prompt?, input? (a dataset, a run whose results it reads, or a process), input_branch (only for a process with several branches), input_mapping {prompt input: column of what it reads}, model?, name?. Omit prompt/input to create an unconnected Generate and connect its inputs later; input_mapping needs both inputs. Steps connect directly: read another step's output instead of saving it as a dataset first. A run or process without a result yet has no known columns: leave out input_mapping, run it, then set input_mapping with update. A process's branches are known once its code has been checked or it has run, so read a process added or rewritten in this proposal in a later one. model is the id of a tested model from the workspace summary's Models list, like the picker beside Create Generate; without it the Generate takes the default Generate model when it first runs. Ask the user which model to use unless they already said or only one model is tested. Its number settings are that model's, from Settings. Not started until the user starts it.
- add_score: ref, run, ground_truth (dataset), comparison [{field (prompt output key), ground_truth_columns, match?}], pairing? [{run_input_column (or "#" for row number), ground_truth_columns, match?}] to decide which ground-truth row belongs to which run row, combine? (all | any); or rule_tree for complete nested rules; or match_code defining match(input_row, output_row, gt_row) instead of rules. match: {ignore_case, ignore_symbols, ignore_whitespace, contains, semantic, embedding, rxnorm, mesh, hgnc, pubchem: booleans; ontology: go | chebi | mondo; numeric: exact | abs | rel | decimals, tolerance, decimals}.
- rule_tree: the complete {v: 2, input, output} from inspect_node.details.rules.ruleTree. Each root/group is {type: "group", children: [rules or groups], ops: ["AND" | "OR", ...]}, one operator per adjacent child. A rule is {type: "rule", outputKey, gtColumns, matchType: "exact", matchFlags}. Input keys are [column], # or [#]; output keys are Prompt output fields. Preserve grouping and matchFlags when editing. Supply rule_tree instead of pairing/comparison/combine/match_code; never flatten a grouped tree to edit it.
- save_run_results: ref, run, name?. Saves a run's results (input columns plus output fields), the same table its readers get, as a plain dataset that records the run and its current History record it came from. Only to freeze or hand-edit results: a dataset does not follow the run, and a step reading it starts a new pipeline. Fails if the run has no History record.
- save_process_output: ref, process, branch? (needed when it has several), name?. Saves one output branch as a plain dataset that records the process, branch and current History record it came from. Only to freeze or hand-edit an output. Fails if the process has no History record.
- save_score_results: ref, score, name?, note?. Saves an Evaluate's comparison table (model output rows beside their matched ground-truth rows and status) as a plain dataset that records the Evaluate and its History record, like Save to workspace. It saves the Evaluate's last saved result, so run it (run_nodes score) first; fails without one.
- apply_review: ref, review, suggestion_ids, name?. Creates a new prompt from the review's prompt with those suggestions applied. The displayed Evaluate History must match the Optimize node's bound evaluation.
- update: node, set {field: value}. prompt: name, note, text_edits or text, output. dataset: name, note, columns, rows (including existing image/PDF cells), row_ids? (parallel to rows; existing IDs from read_rows, null for new rows). Omitted columns retain their types. process: name, code, primary_input, primary_branch. run: name, prompt, input, input_branch, input_mapping (with History enabled, changing these inputs selects a different result or a new run), model (only before its first run; a Generate keeps the model it started with). score: name, ground_truth, comparison (+ pairing, combine), rule_tree, match_code; or exclude_row_keys/include_row_keys (arrays of zero-based GT keys "0", "1", ... or Generate-result keys "run:0", "run:1", ...; change inclusion separately from rules/inputs, and use read_rows.rowKey). Exclusions require a new Evaluate Run before updated metrics or a new Optimize; existing Optimize evidence stays fixed. sampler: name, sampling, size, size_unit, rows (settings only before its first output). review: name. A Prompt or Dataset used in saved results is content-locked; a Sample output also locks its source Dataset. Only name and note can change; use add_prompt_version or duplicate_dataset instead. inspect_node includes contentLock. A Process's code stays editable; History keeps each run.
- connect: node, input, source, branch?. Changes what one input of an existing node reads, as dragging a line onto that input on the canvas does. input is an input id from inspect_node's ports: a run's prompt (source: a prompt) or input; a process's df, one of its df_<name> parameters, or + (adds the source as a new input under its own alias and adds that parameter to process()); a score's ground_truth (source: a dataset). Otherwise source is a dataset, run or process, with branch for a process with several branches. It replaces what the input read; the same rules as on the canvas apply (no loops, not while the step runs, a process's df first, one input per source in a process). A score's run, a review's score and a sampler's source are fixed when the node is made.
- disconnect: node, input. Leaves that input empty, as dragging its line off on the canvas does. A process's df can be disconnected only when nothing else is connected; disconnecting a df_<name> also removes that parameter, unless the code uses it.
- select_history: record_id. Restore that Generate, Process or Evaluate record together with the matching upstream and downstream History lineage, including the inputs it read. Use it alone in a proposal; the user sees and approves the affected nodes.
- delete_history: record_id. Delete a non-current Generate, Process or Evaluate record and every dependent history record. Use it alone in a proposal; the user sees the count before approving.
- remove: node. Like canvas deletion, refuses while downstream nodes still reference it. Disconnect them first, or include their removal in the same proposal.`,
    {
      summary: { type: 'string', description: 'One sentence for the user: what this proposal does and why.' },
      operations: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: attachments ? [...PROPOSE_CHANGES_OPS, 'import_attachment'] : PROPOSE_CHANGES_OPS },
          },
          required: ['op'],
          additionalProperties: true,
        },
      },
    },
    ['summary', 'operations'],
  );
}

export const AGENT_TOOL_DEFINITIONS = [
  tool(
    'inspect_source',
    'Discover available database sources (omit source; optionally query by name). With source, inspect its identifier format, connection options, row_filters capability, fields and samples. Desktop snapshots list exact filenames, sizes and real local download status. Select dataset to inspect local columns and up to 10 sample rows, optionally filtered. This never downloads a missing file: propose download_dataset first. column_query searches wide schemas; returned samples are bounded previews, not total match counts. Online samples require explicit ids, not keyword guessing; use search_source to find IDs when searchable. Hosted deployments expose online sources only.',
    {
      source: { type: 'string', description: 'Exact source key from the catalog; omit to list sources.' },
      query: { type: 'string', description: 'Catalog source-name search, only when source is omitted.' },
      dataset: { type: 'string', description: 'Exact snapshot filename from the source catalog.' },
      column_query: { type: 'string', description: 'Case-insensitive substring to locate columns in wide schemas.' },
      fields: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Columns in the sample; default first 8 fields.' },
      ids: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Online record IDs for a small sample.' },
      sample_rows: { type: 'integer', minimum: 0, maximum: 10, description: 'Preview rows, default 5; 0 returns columns only.' },
      options: { type: 'object', additionalProperties: true, description: 'Non-secret source connection options, such as assembly or program, from the inspected catalog.' },
      filters: { type: 'array', maxItems: 10, items: { type: 'object', properties: {
        column: { type: 'string' }, op: { type: 'string', enum: FILTER_OPERATORS },
        value: { type: ['string', 'number', 'boolean', 'null'] }, values: { type: 'array', maxItems: 100, items: { type: ['string', 'number', 'boolean', 'null'] } }, case_sensitive: { type: 'boolean' },
      }, required: ['column', 'op'], additionalProperties: false } },
    },
  ),
  tool(
    'get_workspace',
    'Rebuild the workspace summary (pipelines and every node with its status). Use it when the canvas may have changed during the conversation, for example after a run finished.',
  ),
  tool(
    PIPELINE_ACTION_TOOL,
    'Ask the user to rename a Pipeline or export its selected route as a Python project zip. The user confirms the action on a card. Use get_workspace for pipeline_id. To run steps, use run_nodes with a run_to job instead.',
    {
      action: { type: 'string', enum: ['export', 'rename'] },
      pipeline_id: { type: 'string', description: 'Exact Pipeline id shown by get_workspace.' },
      name: { type: 'string', description: 'Required new Pipeline name for rename; optional export filename base for export.' },
      summary: { type: 'string', description: 'One sentence explaining this action to the user.' },
    },
    ['action', 'pipeline_id', 'summary'],
  ),
  tool(
    'inspect_node',
    'Full configuration of one node: prompt text, inputs and output schema; dataset columns, a preview and where it came from (producedBy); process code, inputs (a dataset or a step output, with branch and alias), every input it could read under its df_<alias> (availableInputs), its branches and which steps read them; run input (a dataset or a step output), mapping, model and progress; what a run or process waits for (waitingFor); score rules and metrics; review suggestions with verification results; plus its connections, its ports (the dots on its edges: inputs with what each reads and why one cannot be changed, outputs with who reads them; connect and disconnect use these input ids) and any configuration problems. Generate, Process and Evaluate nodes also include saved History records with readable input/output descriptions and currentHistoryRecordId.',
    { node_id: NODE_ID,
      section: { type: 'string', enum: ['overview', 'diagnostics', 'data_refinement', 'stages', 'suggestions', 'verification'], description: 'Optimize details to read. Lists are paged; use verification with suggestion_id for per-row verification evidence.' },
      suggestion_id: { type: 'string', description: 'For an Optimize verification section, the exact suggestion id.' },
      start_row: START_ROW, max_rows: MAX_ROWS,
    },
    ['node_id'],
  ),
  tool(
    'read_rows',
    'Read rows from a dataset, a run (inputs, outputs and errors), a process (one output branch) or a score (comparison of outputs with ground truth). Image/PDF cells include kind, assetIds and names for reusing existing uploaded files. Datasets also return rowIds alongside the rows; preserve these with update row_ids when reordering or deleting rows.',
    {
      node_id: NODE_ID,
      start_row: START_ROW,
      max_rows: MAX_ROWS,
      columns: { type: 'array', items: { type: 'string' }, description: 'Only these columns (datasets, process outputs, run inputs).' },
      branch: { type: 'string', description: 'Process output branch name. Default: the first branch.' },
      only_unmatched: { type: 'boolean', description: 'Evaluate only: return just the rows that did not match.' },
    },
    ['node_id'],
  ),
  tool(
    'trace_row',
    'Follow one input row of a run: the input values, every output the run produced for it, and how each downstream score judged it.',
    {
      run_node_id: { type: 'string', description: 'Exact id of a Generate node.' },
      input_row: { type: 'integer', minimum: 1, description: '1-based row number in the run input.' },
    },
    ['run_node_id', 'input_row'],
  ),
  tool(
    'list_models',
    'Search the OpenRouter model catalog with prices and capabilities, for example to compare the tested models or find one that reads images or pdfs, or a cheaper one. Only the tested models in the workspace summary\'s Models list can be given to a Generate or Optimize; suggest the user add and test another in Settings â†’ Credentials.',
    {
      query: { type: 'string', description: 'Case-insensitive text to match in the model id or name.' },
      vision: { type: 'boolean', description: 'Only models that accept images.' },
      pdf: { type: 'boolean', description: 'Only models that accept pdf files.' },
      tools: { type: 'boolean', description: 'Only models that support tool calling.' },
      sort: { type: 'string', enum: ['price', 'context'], description: 'price: cheapest input first; context: longest context first.' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 15.' },
    },
  ),
  tool(
    'read_guide',
    'Read an AnnoBio guide before explaining how to do something or giving methodological advice.',
    { topic: { type: 'string', enum: GUIDE_TOPICS } },
    ['topic'],
  ),
  tool(
    'search_source',
    `Keyword search of an external source. Returns the total number of matches, the matching ids (up to limit), a few samples and the fields that can be imported. Nothing is imported; use import_dataset in propose_changes for that.
Sources: pubmed, clinicaltrials, chembl; europepmc (literature with abstracts, including preprints; also returns pmids and bioRxiv/medRxiv preprint_dois), openalex (works with citation counts and abstracts; also returns pmids), uniprot (protein entries with function), wikipedia (article introductions for general concepts). Their samples can also be read to answer questions. preprint (bioRxiv/medRxiv) cannot be searched: find preprints in europepmc. Other databases support import by ID: this tool returns their identifier format and importable fields without a keyword search. Use those fields and user-provided IDs with import_dataset.`,
    {
      source: { type: 'string', enum: ['pubmed', 'clinicaltrials', 'chembl', 'preprint', ...REFERENCE_DATABASES.filter((s) => s.kind !== 'snapshot').map((s) => s.source), 'wikipedia'] },
      query: { type: 'string', description: 'PubMed accepts its full query syntax, e.g. "CDK2[tiab] AND phosphorylation[tiab] AND 2020:2025[dp]". Europe PMC accepts its syntax, e.g. "CDK2 AND SRC:PPR" for preprints. UniProt accepts its syntax, e.g. "gene:CDK2 AND organism_id:9606 AND reviewed:true".' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many ids to return. Default 100.' },
    },
    ['source', 'query'],
  ),
  proposeChangesTool(),
  tool(
    'try_process',
    'Try Process code before proposing it. For an existing Process, always pass process_node_id: its actual connections and fixed aliases are preserved even after inputs are renamed. For a new Process, pass primary_input and optional primary_branch; aliases are inferred as for a new node. Only the first max_rows df rows are used; secondary inputs are complete. Returns branches, columns and sample rows or the Python error. No model calls; does not change the canvas.',
    {
      code: { type: 'string', description: 'Python source defining process(df, ...), one parameter per other input.' },
      process_node_id: { type: 'string', description: 'When editing an existing Process, pass its id to preserve its connected inputs and saved aliases. Omit primary_input and primary_branch in that case.' },
      primary_input: { type: 'string', description: 'For a new Process: exact id of the dataset, run or process used as df. Not needed with process_node_id.' },
      primary_branch: { type: 'string', description: 'The branch to read when primary_input is a process with several branches.' },
      max_rows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Rows of the primary dataset to use. Default 50.' },
    },
    ['code'],
  ),
  tool(
    RUN_NODES_TOOL,
    `Ask to run jobs that spend model calls or run code. The user sees each job with its row count, model and estimated cost, and starts or cancels them; the result reports what each job produced. Run one stage at a time, then report and ask before the next (for example run, then review, then verify).

Jobs ("kind" plus):
- run: node (a Generate). Runs the rows it has not processed yet.
- run_to: node (a Generate or Process), mode? (resume, restart, only, resume-node). resume (default) is Resume pipeline to here: reuse current completed results, continue compatible partial Generate results, and run missing or outdated steps up to this node. If everything is current, nothing runs. restart is Restart pipeline to here: run every required upstream step and the target from the beginning without reusing results or partial progress; keep all old History. only is Run only this node: start this node from the beginning using its current upstream results. resume-node continues only this node's compatible partial results. only_this: true is a legacy alias for mode: only. Fails when required inputs, model, mappings or branches are unavailable. Stops at the target; unrelated branches and its downstream are excluded.
- process: node (a Process). Runs its saved code and stores its output branches on the node.
- score: node (an Evaluate node using rules or custom match code). Explicitly runs Evaluate and saves a new immutable History record. Run it again after changing rules, code, ground truth or exclusions before creating Optimize. Each Optimize is permanently bound to the completed Evaluate record it starts from; Verify, Resume and suggestion optimization use that saved evidence.
- review: score, name?, model?. Adds an Optimize node to that score and runs it. model is the id of a tested model from the workspace summary's Models list, like the picker beside Optimize prompt; it also becomes that Evaluate's Optimize model. Without it the Evaluate's Optimize model or the default Optimize model is used. Ask the user which model to use unless they already said or only one model is tested.
- resume_review: review. Resumes that existing interrupted Optimize node; does not create another node.
- verify: review, suggestion_ids? (default: all not yet verified). Re-runs the prompt with each suggestion on the rows it targets.
- optimize_suggestion: review, suggestion_id. For a generated suggestion whose verification did not fully pass (verifyState optimization), run the same wording search as Click to Optimize. Only available when supportsSuggestionOptimization is true. Appends a new unapplied candidate; request verification separately before applying it.
- stop: node. Requests cancellation of an active Run, Process, code Evaluate, Optimize or suggestion optimization, including tasks the user started in the UI. This is a stop request, not a guarantee that already issued model calls have finished.`,
    {
      summary: { type: 'string', description: 'One sentence for the user: what will run and why.' },
      jobs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['run', 'run_to', 'process', 'score', 'review', 'resume_review', 'verify', 'optimize_suggestion', 'stop'] },
            node: { type: 'string' },
            score: { type: 'string' },
            review: { type: 'string' },
            suggestion_ids: { type: 'array', items: { type: 'string' } },
            suggestion_id: { type: 'string' },
            name: { type: 'string' },
            model: { type: 'string', description: 'review only: id of a tested model from the Models list.' },
            only_this: { type: 'boolean', description: 'run_to only: run just this step (its upstream steps must be current).' },
            mode: { type: 'string', enum: ['resume', 'restart', 'only', 'resume-node'], description: 'run_to only: resume the pipeline to this node (default), restart every required step from the beginning, run only this node from the beginning, or resume only this node.' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
    },
    ['summary', 'jobs'],
  ),
  tool(
    ASK_USER_TOOL,
    'Ask the user a question and wait for the answer. Use it when the request is ambiguous in a way that changes what you would do, or when the next step is the user\'s decision. The user can pick an option or type their own answer.',
    {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Short, concrete choices.' },
    },
    ['question', 'options'],
  ),
];

// With no project open (the desktop app, docs/design/AGENT_NO_PROJECT_PLAN.md) there is no canvas
// to read, change or run, so only these are offered, plus create_project.
const NO_PROJECT_TOOL_NAMES = new Set(['list_models', 'read_guide', 'search_source', 'inspect_source', ASK_USER_TOOL, 'read_attachment']);

// Not in AGENT_TOOL_DEFINITIONS: it is only for when no project is open, and leaving it out keeps the
// tools sent with a project open unchanged.
const CREATE_PROJECT_DEFINITION = tool(
  CREATE_PROJECT_TOOL,
  'Ask the user to create a new project for what you have discussed; available only while no project is open. The user confirms on a card and chooses where to save the project file. This conversation then moves into the new project and you continue in the same turn with every tool and the new, empty workspace.',
  {
    name: { type: 'string', description: 'Short project name saying what it is for; suggested as the file name.' },
    summary: { type: 'string', description: 'One sentence telling the user why this project and what you will build in it.' },
  },
  ['name', 'summary'],
);

// Only where the chat takes attachments (the desktop app, docs/design/AGENT_ATTACHMENTS_PLAN.md).
const READ_ATTACHMENT_DEFINITION = tool(
  'read_attachment',
  'Read a window of table rows, PDF pages, source text or extracted Word/PowerPoint/OpenDocument text from an attachment or authorized local path in this conversation. Document text uses offset/max_chars; layout, images and speaker notes are excluded. For a folder id (f1), supply a relative path. JSON source/config can be read with format text. Local path reads share the hard 100-distinct-file conversation budget; repeated windows of the same file do not spend another file.',
  {
    attachment_id: { type: 'string', description: 'Attachment id from a preview, such as a1.' },
    path: { type: 'string', description: 'For a folder id f1: relative file path inside that authorized folder.' },
    format: { type: 'string', enum: ['auto', 'text', 'table'], description: 'JSON: text reads the original config/source, table reads records. Default auto.' },
    start_row: START_ROW,
    max_rows: { type: 'integer', minimum: 1, maximum: 50, description: 'Table rows to return, at most 50. Default 20.' },
    sheet: { type: 'string', description: 'Workbook sheet to read; default the first. The preview lists the sheets.' },
    page: { type: 'integer', minimum: 1, description: 'PDF: first page to read.' },
    max_pages: { type: 'integer', minimum: 1, maximum: 10, description: 'PDF: pages to read, at most 10. Default 3.' },
    offset: { type: 'integer', minimum: 0, description: 'Text: first character to read. Default 0.' },
    max_chars: { type: 'integer', minimum: 1, maximum: 12000, description: 'Text: characters to read, at most 12000. Default 3000.' },
  },
  ['attachment_id'],
);

const PROPOSE_CHANGES_WITH_ATTACHMENTS = proposeChangesTool({ attachments: true });

const FOLDER_ID = { type: 'string', description: 'Authorized folder id from this conversation, such as f1.' };
const FOLDER_TOOLS = [
  tool('list_folder', 'List an authorized local folder without reading file contents. At most 500 entries, 6 levels; skips hidden/build/dependency folders by default. Results prioritize important files. A project over 100 files must be read selectively: README, dependencies, entry points, core pipeline and evaluation. The conversation shares a hard 100-distinct-file content budget across reads and searches.', {
    attachment_id: FOLDER_ID, path: { type: 'string' }, pattern: { type: 'string' }, recursive: { type: 'boolean' }, include_hidden: { type: 'boolean' },
  }, ['attachment_id']),
  tool('search_folder', 'Search text within an authorized folder, important files first. Shares the 100-distinct-file reading budget; at most 200 hits, 300 characters each, 10 seconds and 50 MB scanned. Regex runs in a killable worker. Prefer narrow patterns.', {
    attachment_id: FOLDER_ID, query: { type: 'string' }, regex: { type: 'boolean' }, case_sensitive: { type: 'boolean' }, pattern: { type: 'string' },
    max_results: { type: 'integer', minimum: 1, maximum: 200 },
  }, ['attachment_id', 'query']),
  tool('read_folder', 'Read small previews of important files in an authorized folder, paginated. Shares a hard 100-distinct-file conversation budget with read_attachment and search_folder. At most 30 files and 20000 result characters; default 2000 characters per file. Report unexamined files instead of claiming to have read the whole project.', {
    attachment_id: FOLDER_ID, pattern: { type: 'string' }, path: { type: 'string' },
    max_files: { type: 'integer', minimum: 1, maximum: 30 }, max_chars_per_file: { type: 'integer', minimum: 1, maximum: 12000 }, cursor: { type: 'string' },
  }, ['attachment_id', 'pattern']),
  tool(REQUEST_FOLDER_ACCESS_TOOL, 'Ask permission to read a local folder the user has not provided. Shows Allow / Deny; never grants access until Allow. User-written paths are already authorized on Send; use their folder ids directly. Do not request a parent folder to work around an unsupported file, read error, size limit or revoked access; explain the file error instead. No access to disk roots, home root or system folders.', {
    path: { type: 'string' }, reason: { type: 'string' },
  }, ['path', 'reason']),
];

/**
 * The tools offered for one turn: every one with a project open, otherwise NO_PROJECT_TOOL_NAMES and
 * create_project. Where the chat takes attachments, read_attachment is added and propose_changes
 * also offers import_attachment.
 */
export function agentToolDefinitions({ projectOpen = true, attachments = false } = {}) {
  if (!projectOpen) {
    const offered = AGENT_TOOL_DEFINITIONS.filter((definition) => NO_PROJECT_TOOL_NAMES.has(definition.function.name));
    return [...offered, ...(attachments ? [READ_ATTACHMENT_DEFINITION, ...FOLDER_TOOLS] : []), CREATE_PROJECT_DEFINITION];
  }
  if (!attachments) return AGENT_TOOL_DEFINITIONS;
  return [
    ...AGENT_TOOL_DEFINITIONS.map((definition) => (definition.function.name === PROPOSE_CHANGES_TOOL ? PROPOSE_CHANGES_WITH_ATTACHMENTS : definition)),
    READ_ATTACHMENT_DEFINITION,
    ...FOLDER_TOOLS,
  ];
}

function truncate(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n... [truncated: request fewer rows or columns]`;
}

async function getJson(path) {
  const res = await fetch(`${BACKEND_API_BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.detail || res.statusText);
  return body;
}

function perMillion(price) {
  const n = Number(price);
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1000) / 1000 : null;
}

async function listModels(args) {
  const catalog = await getJson('/api/credentials/openrouter/catalog');
  const query = String(args.query || '').trim().toLowerCase();
  let models = (Array.isArray(catalog) ? catalog : catalog?.models || []).filter((m) => (
    (!query || `${m.id} ${m.name}`.toLowerCase().includes(query))
    && (!args.vision || m.vision)
    && (!args.pdf || m.pdf)
    && (!args.tools || m.tools)
  ));
  if (args.sort === 'price') models = models.slice().sort((a, b) => Number(a.prompt_price) - Number(b.prompt_price));
  if (args.sort === 'context') models = models.slice().sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  const limit = Math.min(30, Math.max(1, Number(args.limit) || 15));
  return {
    matches: models.length,
    models: models.slice(0, limit).map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      usdPerMillionInputTokens: perMillion(m.prompt_price),
      usdPerMillionOutputTokens: perMillion(m.completion_price),
      images: Boolean(m.vision),
      pdf: Boolean(m.pdf),
      toolCalling: Boolean(m.tools),
    })),
  };
}

async function searchSource(args) {
  const sources = await loadSources();
  const importableFields = sources[args.source]?.fields;
  if (sources[args.source]?.searchable === false && args.source !== 'preprint') {
    return { source: args.source, searchable: false, identifier_format: sources[args.source].id,
      importable_fields: importableFields, connection_options: sources[args.source].option_fields || [], note: 'Import records by ID with import_dataset. Configure any required credential on the server, or use the Dataset import dialog to enter it.' };
  }
  const res = await fetch(`${BACKEND_API_BASE}/api/agent/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: args.source, query: args.query, limit: args.limit || 100 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body?.detail || res.statusText, importable_fields: importableFields };
  return { ...body, importable_fields: importableFields };
}

async function inspectSource(args) {
  const sources = await loadSources({ refresh: true });
  if (!args.source) {
    const query = String(args.query || '').toLowerCase();
    return { sources: Object.entries(sources).filter(([key, source]) => `${key} ${source.label} ${source.category || ''}`.toLowerCase().includes(query)).map(([key, source]) => ({ source: key, label: source.label, kind: source.kind || 'online', searchable: source.searchable, row_filters: source.row_filters, ...(source.datasets ? { files: source.datasets.length } : {}) })) };
  }
  let info = sources[args.source];
  if (!info) return { error: 'This source is not available on the connected backend. Use inspect_source without source to list available sources.' };
  if (info.kind === 'snapshot') {
    const status = await getJson(`/api/reference/import/downloads?source=${encodeURIComponent(args.source)}`);
    if (!args.dataset) return { source: args.source, label: info.label, kind: info.kind, datasets: status.files.map(({ name, bytes, status }) => ({ name, bytes, status })), note: 'Choose dataset; missing files require an approved download_dataset proposal before columns can be inspected.' };
    if (!info.datasets.some((file) => file.name === args.dataset)) return { error: 'Choose an exact filename listed for this source.' };
    const schema = await snapshotSchema(args.source, args.dataset);
    if (schema.needs_download) return { source: args.source, ...schema, next_step: 'Propose download_dataset, then inspect_source again once applied.' };
    info = { ...info, ...schema };
  }
  const query = String(args.column_query || '').toLowerCase();
  const entries = Object.entries(info.fields).filter(([key, label]) => `${key} ${label}`.toLowerCase().includes(query));
  const result = { source: args.source, label: info.label, kind: info.kind || 'online', identifier_format: info.id,
    searchable: info.searchable, row_filters: info.row_filters, connection_options: info.option_fields || [],
    ...(args.dataset ? { dataset: args.dataset, fingerprint: info.fingerprint } : {}),
    importable_fields: Object.fromEntries(entries.slice(0, 60)), matching_columns: entries.length,
    note: 'Use exact field keys; column_query finds more columns. Preview rows do not indicate the total number of matching records.' };
  const count = Math.min(10, Math.max(0, args.sample_rows ?? 5));
  if (!count || (info.kind !== 'snapshot' && !args.ids?.length)) return result;
  const fields = args.fields?.length ? args.fields : entries.slice(0, 8).map(([key]) => key);
  if (!fields.length || fields.length > 12 || fields.some((field) => !Object.hasOwn(info.fields, field))) return { ...result, error: 'Choose up to 12 exact fields from the schema.' };
  const options = sourceOptions(info, { ...(args.options || {}), ...(args.dataset ? { dataset: args.dataset, limit: count } : {}), ...(args.filters ? { filters: args.filters } : {}) });
  const data = await sourceJob(args.source, `/api/${args.source}/import`, { ids: args.ids || [], fields, options });
  const cellLimit = Math.min(400, Math.floor(14000 / (count * fields.length)));
  const sample = (data.rows || []).slice(0, count);
  return { ...result, sample_headers: data.headers, samples: sample.map((row) => row.map((value) => String(value ?? '').slice(0, cellLimit))),
    cell_text_truncated: sample.some((row) => row.some((value) => String(value ?? '').length > cellLimit)),
    more_rows: data.truncated === true || (data.rows || []).length > count };
}

/** try_process: run code on the inputs a Process reading primary_input would get (df truncated) and report the branches. */
async function tryProcess(args, runtime) {
  const code = String(args.code || '');
  if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) return { error: 'The code must define process(df).' };
  let inputs;
  try {
    inputs = processTrialInputs(runtime.getCanvasState(), code, args.primary_input, args.primary_branch, args.process_node_id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const maxRows = Math.min(1000, Math.max(1, Number(args.max_rows) || 50));
  const primary = inputs.find((binding) => binding.primary);
  const sent = inputs.map((binding) => (binding.primary
    ? { ...binding, content: { ...binding.content, rows: binding.content.rows.slice(0, maxRows) } } : binding));
  try {
    const { outputs } = await runProcessCode({ code, bindings: sent, signal: runtime.signal });
    return {
      df: { input: primary.label, rowsUsed: Math.min(maxRows, primary.content.rows.length) },
      otherInputs: sent.filter((b) => !b.primary).map((b) => ({ alias: b.alias, input: b.label, rows: b.content.rows.length })),
      branches: Object.entries(outputs).map(([branch, table]) => ({
        branch,
        rows: table.rows.length,
        columns: table.headers,
        firstRows: previewTableRows(table, 5),
      })),
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function titleOf(runtime, nodeId) {
  const node = runtime.getCanvasState().nodes.find((n) => n.nodeId === nodeId);
  return node ? nodeTitle(node) : 'a node';
}

function rowRange(args) {
  const start = Number(args.start_row) || 1;
  const count = Number(args.max_rows) || 5;
  return count === 1 ? `row ${start}` : `rows ${start}-${start + count - 1}`;
}

/** One-line description of a call for the chat's activity list. */
export function describeToolCall(name, args, runtime) {
  switch (name) {
    case 'get_workspace': return 'Refreshed the workspace summary';
    case 'inspect_node': return `Inspected ${titleOf(runtime, args.node_id)}`;
    case 'read_rows': return `Read ${titleOf(runtime, args.node_id)}, ${rowRange(args)}${args.only_unmatched ? ' (unmatched)' : ''}`;
    case 'trace_row': return `Traced row ${args.input_row} of ${titleOf(runtime, args.run_node_id)}`;
    case 'list_models': return `Searched models${args.query ? ` for "${args.query}"` : ''}`;
    case 'read_guide': return `Read the ${args.topic} guide`;
    case 'search_source': return `Searched ${args.source} for "${args.query}"`;
    case 'inspect_source': return args.source ? `Inspected ${args.source}${args.dataset ? ` / ${args.dataset}` : ''}` : 'Listed available database sources';
    case 'try_process': return `Tried process code on ${titleOf(runtime, args.process_node_id || args.primary_input)}`;
    case 'read_attachment': return `Read attachment ${runtime.attachmentName?.(args.attachment_id) || args.attachment_id}`;
    default: return name;
  }
}

/**
 * @param {{getCanvasState: Function, inspectNode: (id: string) => Promise<object>,
 *   getScoreComparisonRows: (id: string) => Promise<object[]>, buildSummary: () => Promise<string>}} runtime
 * @returns {Promise<{ok: boolean, content: string}>} content is what the model sees
 */
export async function executeAgentTool(name, args, runtime) {
  try {
    const result = await runTool(name, args || {}, runtime);
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    return { ok: !(result && typeof result === 'object' && result.error), content: truncate(content) };
  } catch (error) {
    return { ok: false, content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
  }
}

async function runTool(name, args, runtime) {
  switch (name) {
    case 'get_workspace':
      return runtime.buildSummary();
    case 'inspect_node':
      return runtime.inspectNode(String(args.node_id || ''), { section: args.section, suggestionId: args.suggestion_id,
        startRow: args.start_row, maxRows: args.max_rows });
    case 'read_rows': {
      const state = runtime.getCanvasState();
      const node = state.nodes.find((n) => n.nodeId === args.node_id);
      const comparisonRows = node?.type === 'score' ? await runtime.getScoreComparisonRows(node.nodeId) : undefined;
      return readNodeRows(state, args.node_id, {
        startRow: args.start_row,
        maxRows: args.max_rows,
        columns: args.columns,
        branch: args.branch,
        onlyUnmatched: args.only_unmatched === true,
        comparisonRows,
      });
    }
    case 'trace_row': {
      const state = runtime.getCanvasState();
      const scoreIds = state.connections
        .filter((c) => c.type === 'run-to-score' && c.fromId === args.run_node_id)
        .map((c) => c.toId);
      const rowsByScore = new Map();
      for (const id of scoreIds) rowsByScore.set(id, await runtime.getScoreComparisonRows(id));
      return traceRunRow(state, args.run_node_id, args.input_row, rowsByScore);
    }
    case 'list_models':
      return listModels(args);
    case 'read_guide': {
      const body = await getJson(`/api/agent/guides/${encodeURIComponent(String(args.topic || ''))}`);
      return body.content;
    }
    case 'search_source':
      return searchSource(args);
    case 'inspect_source':
      return inspectSource(args);
    case 'try_process':
      return tryProcess(args, runtime);
    case 'read_attachment':
      return runtime.readAttachment(args);
    case 'list_folder': return runtime.listFolder(args);
    case 'search_folder': return runtime.searchFolder(args);
    case 'read_folder': return runtime.readFolder(args);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
