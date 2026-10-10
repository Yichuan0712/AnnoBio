/**
 * run_nodes: jobs that spend model calls or run code (Runs, Processes, Reviews, suggestion
 * verification). previewRunRequest validates the jobs and estimates their cost for the card the user
 * confirms; executeRunRequest runs them in order once confirmed, reporting progress, and returns the
 * results the Agent sees. Execution goes through the same canvas functions the node views use.
 */
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { displayCell } from '../../datasetContent.js';
import { processPrimarySource, runInputSource, stepInputWaitingMessage, stepSourceLabel } from '../../stepInputs.js';
import { stepOutputTable } from '../../stepOutputs.js';
import { formatScoreMetrics } from '../canvas/scoreComparisonPrf.js';
import {
  datasetContentOf,
  inspectWorkflowNode,
  nodeTitle,
  runInputContentOf,
  runResultsOf,
} from '../canvas/workflowNodeInspector.js';

const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKENS_PER_FIELD = 40;
const TABLE_ROWS_GUESS = 3;
const POLL_MS = 1500;
// A stopped Run finishes the rows it already sent to the model before it reports cancelled.
const STOP_WAIT_MS = 90000;

class RunRequestError extends Error {}

function fail(message) {
  throw new RunRequestError(message);
}

let catalogPromise = null;
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(`${BACKEND_API_BASE}/api/credentials/openrouter/catalog`)
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then((body) => new Map((body.models || []).map((m) => [m.id, m])))
      .catch(() => new Map());
  }
  return catalogPromise;
}

async function loadSettings() {
  const res = await fetch(`${BACKEND_API_BASE}/api/settings`);
  return res.ok ? res.json() : {};
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function formatUsd(value) {
  if (value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
}

function credentialLabel(credential) {
  return [credential.provider, credential.model].filter(Boolean).join(' / ');
}

/** Price per token for an OpenRouter credential's model, or null when it cannot be known. */
function priceFor(credential, catalog) {
  if (credential?.provider !== 'openrouter') return null;
  const model = catalog.get(String(credential.model || '').replace(/^openrouter\//, ''));
  const input = Number(model?.prompt_price);
  const output = Number(model?.completion_price);
  return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
}

function findNode(state, id, type, label) {
  const node = state.nodes.find((n) => n.nodeId === String(id || '').trim());
  if (!node) fail(`${label} "${id}" is not a node on the canvas.`);
  if (node.type !== type) fail(`${label} "${id}" is a ${node.type}, not a ${type}.`);
  return node;
}

function upstream(state, nodeId, edgeType) {
  const fromId = state.connections.find((c) => c.type === edgeType && c.toId === nodeId)?.fromId;
  return fromId ? state.nodes.find((n) => n.nodeId === fromId) : null;
}

function runInputTable(state, run) {
  const saved = runInputContentOf(run);
  if (runResultsOf(run).length && Array.isArray(saved.rows) && saved.rows.length) return saved;
  const source = runInputSource(state, run.nodeId);
  if (source && source.kind !== 'dataset') {
    // Another step's output: like the Run window, wait until that step has a complete result.
    const output = stepOutputTable(state, source);
    if (output.waiting) fail(stepInputWaitingMessage(state, source, output.waiting));
    return output.table;
  }
  const dataset = state.nodes.find((n) => n.nodeId === source?.nodeId);
  return dataset ? datasetContentOf(dataset) : { headers: [], rows: [] };
}

// ---------- preview ----------

function previewRun(job, ctx) {
  const run = findNode(ctx.state, job.node, 'run', 'node');
  if (run.runPending) fail(`Run "${nodeTitle(run)}" is already running.`);
  const prompt = upstream(ctx.state, run.nodeId, 'prompt-to-run');
  if (!prompt) fail(`Run "${nodeTitle(run)}" is not connected to a prompt.`);
  if (!(prompt.outputFormat?.fields || []).length) fail(`Prompt "${nodeTitle(prompt)}" has no output fields.`);
  const inspection = inspectWorkflowNode(ctx.state, run.nodeId, { extractInputFields: ctx.extractInputFields });
  const problem = inspection.diagnostics.find((d) => /has no input|without a column|not connected/.test(d));
  if (problem) fail(`Run "${nodeTitle(run)}": ${problem}`);
  const credentialId = String(run.runCredentialId || ctx.settings.default_run_credential_id || '').trim();
  const credential = ctx.credentialsById.get(credentialId);
  if (!credential) fail(`Run "${nodeTitle(run)}" has no usable model credential: choose one on the run or set a default Run model in Settings.`);

  const input = runInputTable(ctx.state, run);
  const done = new Set(runResultsOf(run).map((r) => r?.input_row_index).filter((i) => typeof i === 'number'));
  const pendingRows = input.rows.map((row, index) => ({ row, index })).filter(({ index }) => !done.has(index));
  if (!pendingRows.length) fail(`Run "${nodeTitle(run)}" has already processed all ${input.rows.length} input rows.`);

  const mapping = JSON.parse(run.runInputToColumn || '{}');
  const templateChars = (prompt.sections || []).map((s) => s.content || '').join('\n\n').length;
  let inputChars = 0;
  let fileCells = 0;
  for (const { row } of pendingRows) {
    for (const column of Object.values(mapping)) {
      const cell = row[input.headers.indexOf(column)];
      if (cell && typeof cell === 'object') fileCells += (cell.assetIds || []).length;
      else inputChars += String(cell ?? '').length;
    }
  }
  const fields = prompt.outputFormat.fields.length;
  const outputPerRow = fields * OUTPUT_TOKENS_PER_FIELD * (prompt.outputFormat.returnShape === 'table' ? TABLE_ROWS_GUESS : 1);
  const inputTokens = (pendingRows.length * templateChars + inputChars) / CHARS_PER_TOKEN;
  const outputTokens = pendingRows.length * outputPerRow;
  const price = priceFor(credential, ctx.catalog);
  const usd = price ? inputTokens * price.input + outputTokens * price.output : null;

  const lines = [
    `${pendingRows.length} row${pendingRows.length === 1 ? '' : 's'} of "${stepSourceLabel(ctx.state, runInputSource(ctx.state, run.nodeId))}"${done.size ? ` (continuing after ${done.size} done)` : ''}`,
    `Model: ${credentialLabel(credential)}${run.runCredentialId ? '' : ' (default Run model)'}`,
    `≈ ${Math.round(inputTokens).toLocaleString('en-US')} input and ${Math.round(outputTokens).toLocaleString('en-US')} output tokens`
      + (usd != null ? `, about ${formatUsd(usd)}` : ''),
  ];
  if (fileCells) lines.push(`Also sends ${fileCells} image/pdf file${fileCells === 1 ? '' : 's'}, not included in the estimate.`);
  return { kind: 'run', title: `Run "${nodeTitle(run)}" (prompt "${nodeTitle(prompt)}")`, nodeIds: [run.nodeId], lines, usd, calls: pendingRows.length, priced: usd != null };
}

function previewProcess(job, ctx) {
  const processNode = findNode(ctx.state, job.node, 'process', 'node');
  if (!/^\s*def\s+process\s*\(\s*df\b/m.test(String(processNode.dfCode || ''))) fail(`Process "${nodeTitle(processNode)}" does not define process(df).`);
  if (!String(ctx.settings.python_path || '').trim()) fail('No Python interpreter is set; the user has to choose one in Settings → Python first.');
  const inspection = inspectWorkflowNode(ctx.state, processNode.nodeId, {});
  if (!inspection.details.primaryInput) fail(`Process "${nodeTitle(processNode)}" has no df input.`);
  if (inspection.details.unconnectedInputs?.length) {
    fail(`Process "${nodeTitle(processNode)}": ${inspection.details.unconnectedInputs.join(', ')} not connected; connect an input to each first.`);
  }
  // Like the Process window: every input a step gives must have a complete result.
  if (inspection.details.waitingFor) fail(`Process "${nodeTitle(processNode)}": ${inspection.details.waitingFor}`);
  const df = stepSourceLabel(ctx.state, processPrimarySource(ctx.state, processNode.nodeId));
  return {
    kind: 'process',
    title: `Process "${nodeTitle(processNode)}"`,
    nodeIds: [processNode.nodeId],
    lines: [`Runs its Python code on "${df}" (no model calls).`],
    usd: 0,
    calls: 0,
    priced: true,
  };
}

async function previewReview(job, ctx) {
  const score = findNode(ctx.state, job.score, 'score', 'score');
  const run = upstream(ctx.state, score.nodeId, 'run-to-score');
  if (!run || !runResultsOf(run).length) fail(`Score "${nodeTitle(score)}" has no run results to review.`);
  if (!score.scoreGroundTruthId) fail(`Score "${nodeTitle(score)}" has no ground-truth dataset.`);
  if (score.scoreActiveMatchMode === 'code' && !score.scoreMatchResult) {
    fail(`Score "${nodeTitle(score)}" matches by code and has no code-match result yet; the user runs it from the score view first.`);
  }
  const credentialId = String(score.reviewCredentialId || ctx.settings.default_review_credential_id || '').trim();
  const credential = ctx.credentialsById.get(credentialId);
  if (!credential) fail('No usable Review model: the user has to set a default Review model in Settings (or on the score).');
  const rows = await ctx.getScoreComparisonRows(score.nodeId);
  const failingInputs = new Set(rows.filter((r) => r?.matched !== true).map((r) => r?.input_row_index ?? r?.row_index)).size;
  const cap = Number(ctx.settings.review_max_failed_rows) || 30;
  const analysed = Math.min(failingInputs, cap);
  const lines = [
    `Adds a Review node to score "${nodeTitle(score)}" and runs it (method: ${score.reviewMethod || ctx.settings.default_review_method || 'default'})`,
    `Model: ${credentialLabel(credential)}`,
    !rows.length
      ? 'The score has no comparison rows yet (its run or ground truth may be incomplete), so the review may find nothing to fix.'
      : failingInputs
      ? `Analyses ${analysed} failing input${analysed === 1 ? '' : 's'}${failingInputs > cap ? ` (of ${failingInputs}, capped in Settings)` : ''}: about one model call each plus a few to group issues and draft edits; the exact number depends on the method.`
      : 'Every row currently matches, so the review has little to work with.',
  ];
  return { kind: 'review', title: `Review score "${nodeTitle(score)}"`, nodeIds: [score.nodeId], lines, usd: null, calls: analysed, priced: false };
}

function previewVerify(job, ctx) {
  const review = findNode(ctx.state, job.review, 'promptReview', 'review');
  if (review.reviewPending) fail(`Review "${nodeTitle(review)}" is still running.`);
  const result = JSON.parse(review.reviewResult || '{}');
  const suggestions = (result.suggestions || []).filter((s) => String(s?.source || '').toLowerCase() !== 'assistant');
  const wanted = (Array.isArray(job.suggestion_ids) ? job.suggestion_ids : []).map(String);
  const chosen = wanted.length ? suggestions.filter((s) => wanted.includes(String(s.suggestion_id))) : suggestions;
  if (wanted.length && chosen.length !== wanted.length) {
    fail(`Review "${nodeTitle(review)}" has no suggestion ${wanted.filter((id) => !chosen.some((s) => String(s.suggestion_id) === id)).join(', ')}.`);
  }
  // Same rule as verifyReviewSuggestions: a suggestion with a finished verification is not re-run.
  const toVerify = chosen.filter((s) => {
    const state = String(result.verify_states?.[s.suggestion_id] || 'idle');
    return state === 'idle' || state === 'verifying' || !result.verify_results?.[s.suggestion_id];
  });
  if (!toVerify.length) fail(`The chosen suggestions of review "${nodeTitle(review)}" already have verification results; read them with inspect_node.`);
  const run = upstream(ctx.state, upstream(ctx.state, review.nodeId, 'score-to-prompt-review')?.nodeId, 'run-to-score');
  const credential = ctx.credentialsById.get(String(run?.runCredentialId || ctx.settings.default_run_credential_id || '').trim());
  return {
    kind: 'verify',
    title: `Verify ${toVerify.length} suggestion${toVerify.length === 1 ? '' : 's'} of review "${nodeTitle(review)}"`,
    nodeIds: [review.nodeId],
    lines: [
      `Re-runs the prompt with each suggestion on the rows it targets and checks them against the ground truth: ${toVerify.map((s) => s.suggestion_id).join(', ')}`,
      credential ? `Model: ${credentialLabel(credential)} (the run's model)` : 'Model: the run\'s model',
      'Verification cannot be stopped part-way; the suggestions are checked one after another.',
    ],
    usd: null,
    calls: null,
    priced: false,
    suggestionIds: toVerify.map((s) => String(s.suggestion_id)),
  };
}

/**
 * @param {{jobs: object[]}} request the run_nodes arguments
 * @param {object} env getCanvasState, extractInputFields, credentialsById, getScoreComparisonRows
 */
export async function previewRunRequest(request, env) {
  try {
    const jobs = Array.isArray(request?.jobs) ? request.jobs : [];
    if (!jobs.length) fail('jobs must list at least one job.');
    const [settings, catalog] = await Promise.all([loadSettings(), loadCatalog()]);
    const ctx = { ...env, state: env.getCanvasState(), settings, catalog };
    const items = [];
    for (const [index, job] of jobs.entries()) {
      try {
        const kind = String(job?.kind || '');
        if (kind === 'run') items.push(previewRun(job, ctx));
        else if (kind === 'process') items.push(previewProcess(job, ctx));
        else if (kind === 'review') items.push(await previewReview(job, ctx));
        else if (kind === 'verify') items.push(previewVerify(job, ctx));
        else fail(`kind must be run, process, review or verify, not "${kind}".`);
      } catch (error) {
        if (error instanceof RunRequestError) throw new RunRequestError(`Job ${index + 1}: ${error.message}`);
        throw error;
      }
    }
    const priced = items.every((item) => item.priced);
    const usd = items.reduce((sum, item) => sum + (item.usd || 0), 0);
    const total = priced && usd === 0
      ? 'No model calls, so no model cost.'
      : priced
      ? `Estimated cost: about ${formatUsd(usd)}`
      : `Estimated cost: ${usd > 0 ? `at least ${formatUsd(usd)}; ` : ''}the rest cannot be priced in advance (reviews, verification, or models without OpenRouter pricing)`;
    return { ok: true, items: items.map(({ kind, title, lines, nodeIds }) => ({ kind, title, lines, nodeIds })), total };
  } catch (error) {
    if (error instanceof RunRequestError) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------- execution ----------

async function waitWhile(isBusy, { signal, onTick, onStop }) {
  let stopRequested = false;
  for (;;) {
    if (signal?.aborted && !stopRequested) {
      stopRequested = true;
      await onStop();
      const deadline = Date.now() + STOP_WAIT_MS;
      while (isBusy() && Date.now() < deadline) await sleep(500);
      return 'stopped';
    }
    if (!isBusy()) return 'finished';
    onTick?.();
    await sleep(POLL_MS);
  }
}

function currentNode(env, id) {
  return env.getCanvasState().nodes.find((n) => n.nodeId === id) || null;
}

async function scoreSummaries(env, runNodeId) {
  const state = env.getCanvasState();
  const scores = state.connections.filter((c) => c.type === 'run-to-score' && c.fromId === runNodeId).map((c) => c.toId);
  const out = [];
  for (const id of scores) {
    const inspection = await env.inspectNode(id);
    const m = inspection?.details?.metrics;
    if (m) out.push(`Score "${inspection.title}": ${formatScoreMetrics(m)}`);
  }
  return out;
}

async function executeRun(item, env, { signal, onStatus }) {
  const id = item.nodeIds[0];
  const started = await env.startRunNode({ runNodeId: id });
  if (started.waitRequired) {
    const outcome = await waitWhile(() => currentNode(env, id)?.runPending === true, {
      signal,
      onTick: () => {
        const node = currentNode(env, id);
        const input = runInputContentOf(node || {});
        const done = new Set(runResultsOf(node || {}).map((r) => r?.input_row_index)).size;
        onStatus(`Running "${nodeTitle(node)}": ${done}/${(input.rows || []).length} rows...`);
      },
      onStop: () => {
        onStatus('Stopping: the rows already sent to the model finish first...');
        return env.stopRunNode(id);
      },
    });
    if (outcome === 'stopped') {
      const node = currentNode(env, id);
      const done = new Set(runResultsOf(node || {}).map((r) => r?.input_row_index)).size;
      return {
        status: 'stopped',
        lines: [node?.runPending
          ? `${item.title}: stop requested; it finishes the rows already sent to the model, then stops (${done} rows done so far)`
          : `${item.title}: stopped by the user after ${done} rows; running it again continues from there`],
      };
    }
  }
  const inspection = await env.inspectNode(id);
  const d = inspection.details;
  const errors = d.errorRows ? `, ${d.errorRows} with errors` : '';
  return {
    status: d.status === 'completed' ? 'completed' : 'stopped',
    lines: [`${item.title}: ${d.status}, ${d.inputRowsDone}/${d.inputRows} input rows${errors}`, ...(await scoreSummaries(env, id))],
  };
}

async function executeProcess(item, env, { signal, onStatus }) {
  onStatus(`Running ${item.title}...`);
  const id = item.nodeIds[0];
  try {
    const { outputs, cancelled } = await env.runProcessNode(id, { signal });
    const branches = Object.entries(outputs).map(([name, branch]) => `${name}: ${branch.rows.length} rows`);
    return { status: cancelled ? 'stopped' : 'completed', lines: [`${item.title}: ${branches.join('; ') || 'returned nothing'}`] };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return { status: 'stopped', lines: [`${item.title}: stopped by the user`] };
    return { status: 'failed', lines: [`${item.title} failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function executeReview(item, env, { signal, onStatus, job }) {
  onStatus(`Starting the review of ${item.title.replace(/^Review /, '')}...`);
  const created = await env.createAndRunReviewNode({ scoreNodeId: item.nodeIds[0], name: job.name || '' });
  const reviewId = created.reviewNodeId;
  const outcome = await waitWhile(() => currentNode(env, reviewId)?.reviewPending === true, {
    signal,
    onTick: () => onStatus(`Reviewing: ${Number(currentNode(env, reviewId)?.reviewProgress) || 0}%...`),
    onStop: () => {
      onStatus('Stopping the review...');
      return env.stopReviewNode(reviewId);
    },
  });
  const inspection = await env.inspectNode(reviewId);
  const suggestions = inspection?.details?.suggestions || [];
  return {
    status: outcome === 'stopped' ? 'stopped' : 'completed',
    reviewNodeId: reviewId,
    lines: [
      `${item.title}: ${outcome === 'stopped' ? 'stopped by the user' : 'finished'}; review node "${inspection?.title}" [${reviewId}] has ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`,
      ...suggestions.slice(0, 8).map((s) => `  ${s.id}. ${s.name || s.targetSection}: ${s.reason.slice(0, 160)}`),
    ],
  };
}

async function executeVerify(item, env, { onStatus }) {
  onStatus(`Verifying ${item.suggestionIds.length} suggestion${item.suggestionIds.length === 1 ? '' : 's'}...`);
  const result = await env.verifyReviewSuggestions({ reviewNodeId: item.nodeIds[0], suggestionIds: item.suggestionIds });
  return {
    status: 'completed',
    lines: [
      `${item.title}: ${result.fullyVerifiedCount} verified, ${result.partialOrFailedCount} partial or failed`,
      ...result.verifiedSuggestions.map((s) => {
        const v = s.verifyResult || {};
        const total = Number(v.total) || (v.verifyRows || []).length;
        const label = s.status === 'verified' ? 'verified' : s.status === 'optimization' ? 'did not fix every target row' : 'could not be verified';
        return `  ${s.suggestionId}: ${label}${total ? ` (${Number(v.matchedCount) || 0}/${total} target rows matched)` : ''}`;
      }),
    ],
  };
}

/**
 * Run the confirmed jobs in order. Stops at the first failure or when the user stops.
 * @returns {Promise<{status: 'completed' | 'failed' | 'stopped', results: string[]}>} the tool result
 */
export async function executeRunRequest(request, env, { signal, onStatus = () => {} } = {}) {
  // Re-validate against the canvas as it is now, which may have changed since the card was shown.
  const preview = await previewRunRequest(request, env);
  if (!preview.ok) return { status: 'failed', error: preview.error, results: [] };
  const [settings, catalog] = await Promise.all([loadSettings(), loadCatalog()]);
  const ctx = { ...env, state: env.getCanvasState(), settings, catalog };
  const results = [];
  let status = 'completed';
  let finished = 0;
  for (const job of request.jobs) {
    let item;
    if (job.kind === 'run') item = previewRun(job, ctx);
    else if (job.kind === 'process') item = previewProcess(job, ctx);
    else if (job.kind === 'review') item = await previewReview(job, ctx);
    else item = previewVerify(job, ctx);
    let outcome;
    try {
      if (item.kind === 'run') outcome = await executeRun(item, env, { signal, onStatus });
      else if (item.kind === 'process') outcome = await executeProcess(item, env, { signal, onStatus });
      else if (item.kind === 'review') outcome = await executeReview(item, env, { signal, onStatus, job });
      else outcome = await executeVerify(item, env, { onStatus });
    } catch (error) {
      outcome = { status: 'failed', lines: [`${item.title} failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    results.push(...outcome.lines);
    finished += 1;
    if (outcome.status !== 'completed') {
      status = outcome.status;
      break;
    }
    ctx.state = env.getCanvasState();
  }
  const remaining = request.jobs.length - finished;
  if (remaining > 0) results.push(`Not started: ${remaining} remaining job${remaining === 1 ? '' : 's'}.`);
  return { status, results };
}

/** A few output rows for try_process results. */
export function previewTableRows(table, count = 5) {
  return (table.rows || []).slice(0, count).map((row) => Object.fromEntries(table.headers.map((h, i) => [h, displayCell(row[i])])));
}

