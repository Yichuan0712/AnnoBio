/**
 * run_nodes: jobs that spend model calls or run code (Runs, Processes, custom-code Scores, Reviews, suggestion
 * verification). previewRunRequest validates the jobs and estimates their cost for the card the user
 * confirms; executeRunRequest runs them in order once confirmed, reporting progress, and returns the
 * results the Agent sees. Execution goes through the same canvas functions the node views use.
 */
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { displayCell } from '../../datasetContent.js';
import { processPrimarySource, runInputSource, stepInputWaitingMessage, stepSourceLabel } from '../../stepInputs.js';
import { stepOutputTable } from '../../stepOutputs.js';
import { buildCodeMatchInputs } from '../../scoreCodeRunClient.js';
import { formatScoreMetrics } from '../canvas/scoreComparisonPrf.js';
import { hasNodeExecution, nodeExecutionIdentity } from '../../nodeExecutionControl.js';
import { reviewNeedsResume } from '../../executionResumeState.js';
import { currentNode, executeProcessStep, executeRunStep, waitWhile } from '../../stepExecution.js';
import { planRunTo } from '../../runPlan.js';
import { runTo } from '../../runTo.js';
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
  if (!credential) fail(`Run "${nodeTitle(run)}" has no usable model credential: set a default Run model in Settings.`);

  const input = runInputTable(ctx.state, run);
  const done = new Set(runResultsOf(run).map((r) => r?.input_row_index).filter((i) => typeof i === 'number'));
  const pendingRows = input.rows.map((row, index) => ({ row, index })).filter(({ index }) => !done.has(index));
  if (!pendingRows.length) fail(`Run "${nodeTitle(run)}" has already processed all ${input.rows.length} input rows.`);

  const mapping = JSON.parse(run.runInputToColumn || '{}');
  const templateChars = String(prompt.text || '').trim().length;
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
  if (processNode.processPending) fail(`Process "${nodeTitle(processNode)}" is already running.`);
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

function previewScore(job, ctx) {
  const score = findNode(ctx.state, job.node, 'score', 'node');
  if (score.scoreMatchPending) fail(`Evaluate "${nodeTitle(score)}" is already matching.`);
  if (score.scoreActiveMatchMode !== 'code') fail('Rule-based Evaluate nodes compute automatically; a score job runs custom match code.');
  if (!/^\s*def\s+match\s*\(/m.test(String(score.scoreMatchCode || ''))) fail('Evaluate code must define match(input_row, output_row, gt_row).');
  if (!String(ctx.settings.python_path || '').trim()) fail('No Python interpreter is set; choose one in Settings → Python first.');
  const run = upstream(ctx.state, score.nodeId, 'run-to-score');
  if (!run) fail(`Evaluate "${nodeTitle(score)}" is not connected to a Run.`);
  const groundTruth = findNode(ctx.state, score.scoreGroundTruthId, 'dataset', 'ground truth');
  let payload;
  try {
    payload = buildCodeMatchInputs({ results: runResultsOf(run), outputFields: [],
      input: stepOutputTable(ctx.state, runInputSource(ctx.state, run.nodeId)).table || runInputContentOf(run),
      groundTruth: datasetContentOf(groundTruth) });
  } catch (error) { fail(error.message); }
  return { kind: 'score', title: `Evaluate "${nodeTitle(score)}" using code`, nodeIds: [score.nodeId],
    lines: [`Runs its Python match code on ${payload.runRows.length} Run rows against ${payload.gtRows.length} ground-truth rows (no model calls).`],
    usd: 0, calls: 0, priced: true };
}

async function previewReview(job, ctx) {
  const existing = job.kind === 'resume_review' ? findNode(ctx.state, job.review, 'promptReview', 'review') : null;
  if (existing && (hasNodeExecution(existing.nodeId) || !reviewNeedsResume({ result: JSON.parse(existing.reviewResult || '{}'),
    interrupted: existing.reviewInterrupted === true, streaming: existing.reviewPending === true }))) fail('This Optimize has no interrupted task to resume.');
  const score = existing ? upstream(ctx.state, existing.nodeId, 'score-to-prompt-review') : findNode(ctx.state, job.score, 'score', 'score');
  if (!score) fail('Optimize is not connected to an Evaluate node.');
  const run = upstream(ctx.state, score.nodeId, 'run-to-score');
  if (!run || !runResultsOf(run).length) fail(`Evaluate "${nodeTitle(score)}" has no run results to review.`);
  if (!score.scoreGroundTruthId) fail(`Evaluate "${nodeTitle(score)}" has no ground-truth dataset.`);
  if (score.scoreActiveMatchMode === 'code' && !score.scoreMatchResult) {
    fail(`Evaluate "${nodeTitle(score)}" matches by code and has no code-match result yet; run a score job first.`);
  }
  // A resumed Optimize keeps the model it started with (resumeReviewNode).
  const credentialId = String(existing?.reviewCredentialId || score.reviewCredentialId || ctx.settings.default_review_credential_id || '').trim();
  const credential = ctx.credentialsById.get(credentialId);
  if (!credential) fail('No usable Optimize model: set a default Optimize model in Settings.');
  const rows = await ctx.getScoreComparisonRows(score.nodeId);
  const failingInputs = new Set(rows.filter((r) => r?.matched !== true).map((r) => r?.input_row_index ?? r?.row_index)).size;
  const cap = Number(ctx.settings.review_max_failed_rows) || 30;
  const analysed = Math.min(failingInputs, cap);
  const lines = [
    `${existing ? 'Resumes the existing Optimize' : 'Adds an Optimize node'} on Evaluate "${nodeTitle(score)}" (method: ${score.reviewMethod || ctx.settings.default_review_method || 'default'})`,
    `Model: ${credentialLabel(credential)}`,
    !rows.length
      ? 'The Evaluate node has no comparison rows yet (its Run or ground truth may be incomplete), so the Optimize may find nothing to fix.'
      : failingInputs
      ? `Analyses ${analysed} failing input${analysed === 1 ? '' : 's'}${failingInputs > cap ? ` (of ${failingInputs}, capped in Settings)` : ''}: about one model call each plus a few to group issues and draft edits; the exact number depends on the method.`
      : 'Every row currently matches, so the review has little to work with.',
  ];
  return { kind: existing ? 'resume_review' : 'review', title: `${existing ? 'Resume Optimize' : 'Optimize prompt'} using "${nodeTitle(score)}"`, nodeIds: [existing?.nodeId || score.nodeId], lines, usd: null, calls: analysed, priced: false };
}

function previewSuggestionOptimization(job, ctx) {
  const review = findNode(ctx.state, job.review, 'promptReview', 'review');
  if (review.reviewPending || hasNodeExecution(review.nodeId)) fail('This Optimize already has an active task.');
  const result = JSON.parse(review.reviewResult || '{}');
  if (result.supports_segment_optimization === false) fail('This method does not support suggestion-level optimization.');
  const id = String(job.suggestion_id || '');
  const suggestion = (result.suggestions || []).find((entry) => String(entry.suggestion_id) === id);
  if (!suggestion || String(suggestion.source).toLowerCase() === 'assistant') fail('Choose an existing generated suggestion_id.');
  if (result.verify_states?.[id] !== 'optimization') fail('Verify the suggestion first; it must have a completed verification that did not fully pass.');
  const trials = Math.min(200, Math.max(4, Number(ctx.settings.optimization_max_trials) || 40));
  return { kind: 'optimize_suggestion', title: `Optimize suggestion ${id} of "${nodeTitle(review)}"`, nodeIds: [review.nodeId],
    lines: [`Searches wording variants for up to ${trials} trials, using target inputs and up to two regression inputs.`,
      'Uses model calls. Appends a new unapplied suggestion; its quality must be verified separately.'],
    trials, suggestionId: id, usd: null, calls: null, priced: false };
}

function previewStop(job, ctx) {
  const node = ctx.state.nodes.find((entry) => entry.nodeId === job.node);
  if (!node || !['run', 'process', 'score', 'promptReview'].includes(node.type)) fail('Stop needs a Run, Process, Evaluate or Optimize node.');
  if (!hasNodeExecution(node.nodeId) && !node.runPending && !node.processPending && !node.scoreMatchPending && !node.reviewPending) fail('That node has no active task to stop.');
  const taskId = ctx.getNodeTaskIdentity?.(node.nodeId) || nodeExecutionIdentity(node.nodeId);
  if (!taskId) fail('This task is still starting. Refresh the workspace and prepare the stop request again when its job is registered.');
  return { kind: 'stop', title: `Stop "${nodeTitle(node)}"`, nodeIds: [node.nodeId],
    taskId,
    lines: ['Requests cancellation of the active node task. Already issued model requests may finish first.'], usd: 0, calls: 0, priced: true };
}

const formatRows = (rows) => (rows == null ? 'unknown rows' : `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}`);

/** run_to: the plan for a Run or Process, as the user's Run to here shows it (runPlan.js). */
function previewRunTo(job, ctx) {
  const target = ctx.state.nodes.find((n) => n.nodeId === String(job.node || '').trim());
  if (!target) fail(`node "${job.node}" is not a node on the canvas.`);
  if (!['run', 'process'].includes(target.type)) fail(`node "${job.node}" is a ${target.type}; run_to works on a Run or a Process.`);
  const plan = planRunTo(ctx.state, target.nodeId, { settings: ctx.settings, credentialIds: new Set(ctx.credentialsById.keys()) });
  if (plan.problems.length) fail(plan.problems.map((problem) => problem.message).join(' '));
  const name = plan.steps.at(-1)?.name || nodeTitle(target);
  if (!plan.toRun) fail(`Everything up to "${name}" already has current results; nothing to run.`);
  const reused = plan.steps.filter((step) => step.action === 'reuse');
  const running = plan.steps.filter((step) => step.action !== 'reuse');
  const lines = [
    `Inputs: ${plan.inputs.map((input) => `${input.name} (${formatRows(input.rows)})`).join(', ') || 'none'}`,
    ...(reused.length ? [`Uses existing results: ${reused.map((step) => step.name).join(', ')}`] : []),
    `Runs, in order: ${running.map((step) => `${step.name}${step.action === 'resume' ? ' (continues)' : ''}`).join(' → ')}`,
    plan.calls == null ? 'Model calls: unknown until the steps before them have run.' : `Model calls: ${plan.calls.toLocaleString('en-US')}`,
  ];
  return { kind: 'run_to', title: `Run to "${name}"`, nodeIds: running.map((step) => step.nodeId), lines, usd: null, calls: plan.calls,
    priced: false, targetId: target.nodeId, planSteps: plan.steps.map(({ nodeId, action }) => ({ nodeId, action })) };
}

async function executeRunTo(item, env, ctx, { signal, onStatus, approvedSteps }) {
  const options = {
    context: { settings: ctx.settings, credentialIds: new Set(ctx.credentialsById.keys()) },
    signal,
    approvedPlan: { steps: approvedSteps || item.planSteps },
    onStep: (step) => onStatus(`${step.name}: ${step.status}`),
  };
  // The canvas keeps a record of it in Executions, as for the user's Run to here.
  const task = env.runPlanned ? await env.runPlanned(item.targetId, options) : await runTo(item.targetId, env, options);
  const lines = task.steps.filter((step) => step.status !== 'reused').map((step) => `${step.name}: ${step.status}${step.errorRows ? `, ${step.errorRows} rows with errors` : ''}${step.message && step.status !== 'completed' ? ` (${step.message})` : ''}`);
  return { status: task.status, lines: task.error ? [`${item.title}: ${task.error}`, ...lines] : lines };
}

function previewJob(job, ctx) {
  switch (job?.kind) {
    case 'run': return previewRun(job, ctx);
    case 'run_to': return previewRunTo(job, ctx);
    case 'process': return previewProcess(job, ctx);
    case 'score': return previewScore(job, ctx);
    case 'review': case 'resume_review': return previewReview(job, ctx);
    case 'verify': return previewVerify(job, ctx);
    case 'optimize_suggestion': return previewSuggestionOptimization(job, ctx);
    case 'stop': return previewStop(job, ctx);
    default: fail('Unknown job kind. Use run, run_to, process, score, review, resume_review, verify, optimize_suggestion or stop.');
  }
}

function previewVerify(job, ctx) {
  const review = findNode(ctx.state, job.review, 'promptReview', 'review');
  if (review.reviewPending || hasNodeExecution(review.nodeId)) fail(`Optimize "${nodeTitle(review)}" is still running.`);
  const result = JSON.parse(review.reviewResult || '{}');
  const suggestions = (result.suggestions || []).filter((s) => String(s?.source || '').toLowerCase() !== 'assistant');
  const wanted = (Array.isArray(job.suggestion_ids) ? job.suggestion_ids : []).map(String);
  const chosen = wanted.length ? suggestions.filter((s) => wanted.includes(String(s.suggestion_id))) : suggestions;
  if (wanted.length && chosen.length !== wanted.length) {
    fail(`Optimize "${nodeTitle(review)}" has no suggestion ${wanted.filter((id) => !chosen.some((s) => String(s.suggestion_id) === id)).join(', ')}.`);
  }
  // Same rule as verifyReviewSuggestions: a suggestion with a finished verification is not re-run.
  const toVerify = chosen.filter((s) => {
    const state = String(result.verify_states?.[s.suggestion_id] || 'idle');
    return state === 'idle' || state === 'verifying' || !result.verify_results?.[s.suggestion_id];
  });
  if (!toVerify.length) fail(`The chosen suggestions of Optimize "${nodeTitle(review)}" already have verification results; read them with inspect_node.`);
  const run = upstream(ctx.state, upstream(ctx.state, review.nodeId, 'score-to-prompt-review')?.nodeId, 'run-to-score');
  const credential = ctx.credentialsById.get(String(run?.runCredentialId || ctx.settings.default_run_credential_id || '').trim());
  return {
    kind: 'verify',
    title: `Verify ${toVerify.length} suggestion${toVerify.length === 1 ? '' : 's'} of Optimize "${nodeTitle(review)}"`,
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
    const stopOnly = jobs.every((job) => job.kind === 'stop');
    const [settings, catalog] = stopOnly ? [{}, new Map()] : await Promise.all([loadSettings(), loadCatalog()]);
    const ctx = { ...env, state: env.getCanvasState(), settings, catalog };
    const items = [];
    for (const [index, job] of jobs.entries()) {
      try {
        items.push(await previewJob(job, ctx));
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
    return { ok: true, items: items.map(({ kind, title, lines, nodeIds, planSteps }) => ({ kind, title, lines, nodeIds, ...(planSteps ? { planSteps } : {}) })), total,
      stopGuards: items.filter((item) => item.kind === 'stop').map((item) => ({ nodeId: item.nodeIds[0], taskId: item.taskId })),
      projectIdentity: env.getAssetProjectId?.() ?? null };
  } catch (error) {
    if (error instanceof RunRequestError) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------- execution ----------

async function scoreSummaries(env, runNodeId) {
  const state = env.getCanvasState();
  const scores = state.connections.filter((c) => c.type === 'run-to-score' && c.fromId === runNodeId).map((c) => c.toId);
  const out = [];
  for (const id of scores) {
    const inspection = await env.inspectNode(id);
    const m = inspection?.details?.metrics;
    if (m) out.push(`Evaluate "${inspection.title}": ${formatScoreMetrics(m)}`);
  }
  return out;
}

/** A Run job, with the Evaluate scores that read it once it has finished. */
async function executeRun(item, env, options) {
  const outcome = await executeRunStep(item, env, options);
  return outcome.inspected ? { ...outcome, lines: [...outcome.lines, ...(await scoreSummaries(env, item.nodeIds[0]))] } : outcome;
}

async function executeProcess(item, env, options) {
  return executeProcessStep(item, env, options);
}

async function executeReview(item, env, { signal, onStatus, job }) {
  onStatus('Starting prompt optimization...');
  const created = item.kind === 'resume_review' ? await env.resumeReviewNode(item.nodeIds[0])
    : await env.createAndRunReviewNode({ scoreNodeId: item.nodeIds[0], name: job.name || '' });
  const reviewId = created.reviewNodeId;
  const outcome = await waitWhile(() => currentNode(env, reviewId)?.reviewPending === true, {
    signal,
    onTick: () => onStatus(`Optimizing: ${Number(currentNode(env, reviewId)?.reviewProgress) || 0}%...`),
    onStop: () => {
      onStatus('Stopping optimization...');
      return env.stopReviewNode(reviewId);
    },
  });
  const inspection = await env.inspectNode(reviewId);
  const suggestions = inspection?.details?.suggestions || [];
  const suggestionCount = inspection?.details?.suggestionCount ?? suggestions.length;
  const complete = inspection?.found !== false && inspection?.details?.status === 'finished';
  const status = outcome === 'stopped' ? 'stopped' : complete ? 'completed' : 'failed';
  return {
    status,
    reviewNodeId: reviewId,
    lines: [
      `${item.title}: ${status === 'stopped' ? 'stopped by the user' : complete ? 'finished' : `did not complete (${inspection?.details?.status || 'node unavailable'})`}; Optimize node "${inspection?.title}" [${reviewId}] has ${suggestionCount} suggestion${suggestionCount === 1 ? '' : 's'}`,
      ...suggestions.slice(0, 8).map((s) => `  ${s.id}. ${s.name || 'Prompt edit'}: ${s.reason.slice(0, 160)}`),
    ],
  };
}

async function executeScore(item, env, { signal, onStatus }) {
  const id = item.nodeIds[0];
  let result;
  try {
    result = await env.runScoreNode(id, { signal,
      onProgress: (completed, total) => onStatus(`Matching ${item.title}: ${completed}/${total} rows...`),
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return { status: 'stopped', lines: [`${item.title}: stopped by the user`] };
    throw error;
  }
  const matched = result.outcomes.filter((outcome) => outcome.ok && typeof outcome.matched_gt_index === 'number').length;
  const errors = result.outcomes.filter((outcome) => !outcome.ok).length;
  return { status: result.wasCancelled ? 'stopped' : 'completed',
    lines: [`${item.title}: ${result.wasCancelled ? 'stopped' : 'finished'}; ${matched}/${result.outcomes.length} Run rows matched${errors ? `, ${errors} with errors` : ''}`],
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
export async function executeRunRequest(request, env, { signal, onStatus = () => {}, approvedPreview } = {}) {
  // Re-validate against the canvas as it is now, which may have changed since the card was shown.
  const preview = await previewRunRequest(request, env);
  if (!preview.ok) return { status: 'failed', error: preview.error, results: [] };
  if (approvedPreview && ((approvedPreview.projectIdentity ?? null) !== preview.projectIdentity
    || JSON.stringify(approvedPreview.stopGuards || []) !== JSON.stringify(preview.stopGuards))) {
    return { status: 'failed', error: 'The project or task to stop changed after the card was prepared. Prepare the request again.', results: [] };
  }
  const stopOnly = request.jobs.every((job) => job.kind === 'stop');
  const [settings, catalog] = stopOnly ? [{}, new Map()] : await Promise.all([loadSettings(), loadCatalog()]);
  const ctx = { ...env, state: env.getCanvasState(), settings, catalog };
  const results = [];
  let status = 'completed';
  let finished = 0;
  for (const job of request.jobs) {
    let item;
    let outcome;
    try {
      if (signal?.aborted) { status = 'stopped'; break; }
      item = await previewJob(job, ctx);
      if (item.kind === 'run') outcome = await executeRun(item, env, { signal, onStatus });
      else if (item.kind === 'run_to') {
        // The plan the user confirmed on the card, not the one just made again.
        const approvedSteps = approvedPreview?.items?.[request.jobs.indexOf(job)]?.planSteps;
        outcome = await executeRunTo(item, env, ctx, { signal, onStatus, approvedSteps });
      }
      else if (item.kind === 'process') outcome = await executeProcess(item, env, { signal, onStatus });
      else if (item.kind === 'score') outcome = await executeScore(item, env, { signal, onStatus });
      else if (item.kind === 'review' || item.kind === 'resume_review') outcome = await executeReview(item, env, { signal, onStatus, job });
      else if (item.kind === 'stop') {
        const guard = preview.stopGuards.find((entry) => entry.nodeId === item.nodeIds[0]);
        if (guard?.taskId !== item.taskId) throw new Error('The task changed. Prepare the stop request again.');
        await env.stopNodeTask(item.nodeIds[0]);
        outcome = { status: 'completed', lines: [`${item.title}: cancellation requested; refresh the workspace to check when it stops.`] };
      } else if (item.kind === 'optimize_suggestion') {
        const result = await env.optimizeSuggestion({ reviewNodeId: item.nodeIds[0], suggestionId: item.suggestionId,
          signal, maxTrials: item.trials, onProgress: ({ trial, trials }) => onStatus(`Optimizing suggestion: ${trial}/${trials} trials...`) });
        outcome = { status: 'completed', lines: [`${item.title}: created suggestion ${result.suggestionId} after ${result.trials} trials. Verify the new suggestion before applying it.`] };
      } else outcome = await executeVerify(item, env, { onStatus });
    } catch (error) {
      outcome = { status: signal?.aborted || error?.name === 'AbortError' ? 'stopped' : 'failed', lines: [`${item?.title || job.kind}: ${error instanceof Error ? error.message : String(error)}`] };
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

