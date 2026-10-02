/**
 * The Agent's tools: OpenAI-format definitions sent with every turn, and their executors, which run
 * here in the renderer against the live canvas. ask_user is defined here but handled by the loop,
 * since answering it takes the user, not code.
 */
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { nodeTitle, readNodeRows, traceRunRow } from '../canvas/workflowNodeInspector.js';
import { loadSources } from '../operations/proposals.js';
import { previewTableRows } from '../execution/runJobs.js';
import { runProcessCode } from '../../processRunClient.js';

const MAX_TOOL_RESULT_CHARS = 24000;

export const ASK_USER_TOOL = 'ask_user';
export const PROPOSE_CHANGES_TOOL = 'propose_changes';
export const RUN_NODES_TOOL = 'run_nodes';

/** Tools answered by the user rather than by code; calling one ends the loop until they respond. */
export const USER_TOOLS = new Set([ASK_USER_TOOL, PROPOSE_CHANGES_TOOL, RUN_NODES_TOOL]);

const GUIDE_TOPICS = [
  'pipeline-building',
  'process-code',
  'prompt-design',
  'evaluation',
  'prompt-optimization',
  'export-and-share',
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

export const AGENT_TOOL_DEFINITIONS = [
  tool(
    'get_workspace',
    'Rebuild the workspace summary (pipelines and every node with its status). Use it when the canvas may have changed during the conversation, for example after a run finished.',
  ),
  tool(
    'inspect_node',
    'Full configuration of one node: prompt sections, inputs and output schema; dataset columns and a preview; process code, inputs, aliases and outputs; run mapping, model and progress; score rules and metrics; review suggestions with verification results; plus its connections and any configuration problems.',
    { node_id: NODE_ID },
    ['node_id'],
  ),
  tool(
    'read_rows',
    'Read rows from a dataset, a run (inputs, outputs and errors), a process (one output branch) or a score (comparison of outputs with ground truth).',
    {
      node_id: NODE_ID,
      start_row: START_ROW,
      max_rows: MAX_ROWS,
      columns: { type: 'array', items: { type: 'string' }, description: 'Only these columns (datasets, process outputs, run inputs).' },
      branch: { type: 'string', description: 'Process output branch name. Default: the first branch.' },
      only_unmatched: { type: 'boolean', description: 'Score only: return just the rows that did not match.' },
    },
    ['node_id'],
  ),
  tool(
    'trace_row',
    'Follow one input row of a run: the input values, every output the run produced for it, and how each downstream score judged it.',
    {
      run_node_id: { type: 'string', description: 'Exact id of a Run node.' },
      input_row: { type: 'integer', minimum: 1, description: '1-based row number in the run input.' },
    },
    ['run_node_id', 'input_row'],
  ),
  tool(
    'list_models',
    'Search the OpenRouter model catalog with prices and capabilities. Use it to recommend a model for a Run (for example one that reads images or pdfs, or a cheaper one).',
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
    'Keyword search of PubMed, ClinicalTrials.gov or ChEMBL. Returns the total number of matches, the matching ids (up to limit) and a few samples, plus the fields that can be imported. Nothing is imported; use import_dataset in propose_changes for that. bioRxiv/medRxiv (preprint) cannot be searched, only imported by DOI.',
    {
      source: { type: 'string', enum: ['pubmed', 'clinicaltrials', 'chembl', 'preprint'] },
      query: { type: 'string', description: 'PubMed accepts its full query syntax, e.g. "CDK2[tiab] AND phosphorylation[tiab] AND 2020:2025[dp]".' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many ids to return. Default 100.' },
    },
    ['source', 'query'],
  ),
  tool(
    PROPOSE_CHANGES_TOOL,
    `Propose changes to the canvas. The user sees each change on a card and applies or rejects the whole proposal; nothing changes before that. The result tells you whether it was applied and the ids of added nodes. Put related changes in one proposal (a new prompt version with its run and score, for example). Only remove nodes the user asked to remove.

Reference existing nodes by id. A node added earlier in the same proposal is referenced by the "ref" you gave it, which must start with "$".

Operations ("op" plus the fields listed):
- add_dataset: ref, name, note?, columns (names), rows (lists of cells, or objects keyed by column). Text only.
- import_dataset: ref, source (pubmed | clinicaltrials | chembl | preprint), ids, fields (from search_source's importable_fields), name, note?. Records are fetched when applied.
- add_sampler: ref (the sampler), dataset_ref (the sampled dataset), source (dataset), sampling (random | random_with_replacement | rows), size + size_unit (rows | percent) for random, rows ("1 3 5-10") for rows, name?, dataset_name?.
- add_process: ref, name, primary_input (dataset, df in the code), code defining process(df); other datasets are df_<alias> (see inspect_node on a process, or the process-code guide). Not run until the user runs it.
- add_prompt: ref, name, note?, sections [{name, content}] with {variable} inputs, input_types? {variable: text | image | pdf}, output {return_shape: single | table, fields [{key, type: str | float | list_str | list_float, description, examples?}]}.
- add_prompt_version: ref, prompt (source), name?, and what to change: section_edits [{name, content}] (replaces those sections by name, appends new names, keeps the rest) or sections (the complete new list), input_types, output (only what changes: {return_shape} alone keeps the fields), note. Everything else is copied. Prefer this over editing a prompt that already has runs.
- add_run: ref, prompt, input_dataset, input_mapping {prompt input: column}, name?. It uses the model and settings in Settings → Run defaults. Not started until the user starts it.
- add_score: ref, run, ground_truth (dataset), comparison [{field (prompt output key), ground_truth_columns, match?}], pairing? [{run_input_column (or "#" for row number), ground_truth_columns, match?}] to decide which ground-truth row belongs to which run row, combine? (all | any); or match_code defining match(input_row, output_row, gt_row) instead of rules. match: {ignore_case, ignore_symbols, ignore_whitespace, contains, semantic, embedding, rxnorm, mesh: booleans; numeric: exact | abs | rel | decimals, tolerance, decimals}.
- save_run_results: ref, run, name?. Saves a run's results (input columns plus output fields) as a dataset.
- save_process_output: ref, process, branch? (needed when it has several), name?. Saves one output branch as a dataset.
- apply_review: ref, review, suggestion_ids, name?. Creates a new prompt from the review's prompt with those suggestions applied.
- update: node, set {field: value}. prompt: name, note, section_edits or sections, input_types, output. dataset: name, note, columns, rows (text-only ordinary datasets). process: name, code, primary_input. run: name, prompt, input_dataset, input_mapping (with History enabled, changing these inputs selects a different result or a new run). score: name, ground_truth, comparison (+ pairing, combine), match_code. sampler, review: name.
- select_history: record_id. Restore that Run or Process record and its ancestor inputs. Use it alone in a proposal; the user sees and approves the affected nodes.
- delete_history: record_id. Delete a non-current Run or Process record and every dependent history record. Use it alone in a proposal; the user sees the count before approving.
- remove: node.`,
    {
      summary: { type: 'string', description: 'One sentence for the user: what this proposal does and why.' },
      operations: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add_dataset', 'import_dataset', 'add_sampler', 'add_process', 'add_prompt', 'add_prompt_version', 'add_run', 'add_score', 'save_run_results', 'save_process_output', 'apply_review', 'update', 'select_history', 'delete_history', 'remove'] },
          },
          required: ['op'],
          additionalProperties: true,
        },
      },
    },
    ['summary', 'operations'],
  ),
  tool(
    'try_process',
    'Run Process code on the canvas data without changing anything, to check it before proposing it. df is the primary dataset (only its first max_rows rows); other datasets are available as df_<alias> in full. Returns each output branch with its row count, columns and first rows, or the Python error. No model calls, nothing to confirm.',
    {
      code: { type: 'string', description: 'Python source defining process(df).' },
      primary_input: { type: 'string', description: 'Exact id of the dataset used as df.' },
      max_rows: { type: 'integer', minimum: 1, maximum: 1000, description: 'Rows of the primary dataset to use. Default 50.' },
    },
    ['code', 'primary_input'],
  ),
  tool(
    RUN_NODES_TOOL,
    `Ask to run jobs that spend model calls or run code. The user sees each job with its row count, model and estimated cost, and starts or cancels them; the result reports what each job produced. Run one stage at a time, then report and ask before the next (for example run, then review, then verify).

Jobs ("kind" plus):
- run: node (a Run). Runs the rows it has not processed yet.
- process: node (a Process). Runs its saved code and stores its output branches on the node.
- review: score, name?. Adds a Review node to that score and runs it.
- verify: review, suggestion_ids? (default: all not yet verified). Re-runs the prompt with each suggestion on the rows it targets.`,
    {
      summary: { type: 'string', description: 'One sentence for the user: what will run and why.' },
      jobs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['run', 'process', 'review', 'verify'] },
            node: { type: 'string' },
            score: { type: 'string' },
            review: { type: 'string' },
            suggestion_ids: { type: 'array', items: { type: 'string' } },
            name: { type: 'string' },
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
  const res = await fetch(`${BACKEND_API_BASE}/api/agent/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: args.source, query: args.query, limit: args.limit || 100 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body?.detail || res.statusText, importable_fields: importableFields };
  return { ...body, importable_fields: importableFields };
}

/** try_process: run code on the canvas datasets (the primary one truncated) and report the branches. */
async function tryProcess(args, runtime) {
  const state = runtime.getCanvasState();
  const primary = state.nodes.find((n) => n.nodeId === args.primary_input && n.type === 'dataset');
  if (!primary) return { error: 'primary_input must be the id of a dataset on the canvas.' };
  const code = String(args.code || '');
  if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) return { error: 'The code must define process(df).' };
  const bindings = runtime.getDatasetBindings(primary.nodeId);
  const used = new Set(code.match(/\bdf_[A-Za-z_][A-Za-z0-9_]*\b/g) || []);
  const unknown = [...used].filter((alias) => !bindings.some((b) => b.alias === alias));
  if (unknown.length) {
    return { error: `Unknown dataset alias ${unknown.join(', ')}. Available: ${bindings.filter((b) => !b.primary).map((b) => `${b.alias} ("${b.name}")`).join(', ')}` };
  }
  const maxRows = Math.min(1000, Math.max(1, Number(args.max_rows) || 50));
  const sent = bindings
    .filter((b) => b.primary || used.has(b.alias))
    .map((b) => (b.primary ? { ...b, content: { ...b.content, rows: b.content.rows.slice(0, maxRows) } } : b));
  try {
    const { outputs } = await runProcessCode({ code, bindings: sent, signal: runtime.signal });
    return {
      df: { dataset: nodeTitle(primary), rowsUsed: Math.min(maxRows, primary.datasetContent?.rows?.length || 0) },
      otherDatasets: sent.filter((b) => !b.primary).map((b) => ({ alias: b.alias, dataset: b.name, rows: b.content.rows.length })),
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
    case 'try_process': return `Tried process code on ${titleOf(runtime, args.primary_input)}`;
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
      return runtime.inspectNode(String(args.node_id || ''));
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
    case 'try_process':
      return tryProcess(args, runtime);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
