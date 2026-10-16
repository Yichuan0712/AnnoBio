/**
 * "Run to here" (docs/design/RUN_TO_HERE_PLAN.md step 1): which steps up to a Run or Process are
 * reused, which run, what they read and roughly how many rows. Pure: canvas state as
 * getCanvasState() saves it (each step carrying its current History result) in, plan out.
 *
 * A step with a current complete result is reused. One without runs; its downstream steps then have
 * no result either (their History signature names the upstream record), so they run too.
 */
import { extractInputFields } from './promptText.js';
import { effectiveProcessOutputs } from './processOutputPorts.js';
import { stepOutputTable } from './stepOutputs.js';
import {
  RESULT_PORT, processRequiredInputs, runInputSource, sourceKey, stepInputWaitingMessage, stepSourceLabel,
} from './stepInputs.js';

const STEP_TYPES = new Set(['run', 'process']);
const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

const isStepSource = (source) => STEP_TYPES.has(source?.kind);
const processCode = (node) => String(node?.dfCode || node?.code || '');

/** The sources a step runs with: a Run's one input, or every input a Process's code is given. */
function stepSources(state, node) {
  if (node.type === 'run') {
    const source = runInputSource(state, nodeIdOf(node));
    return source ? [source] : [];
  }
  return processRequiredInputs(state, nodeIdOf(node), { code: processCode(node) }).bindings
    .map(({ nodeId, port, kind, primary }) => ({ nodeId, port, kind, primary: !!primary }));
}

/** 'ready' (a current complete result), 'stopped' (part way, can continue), 'running' or 'missing'. */
function stepState(node) {
  if (node.type === 'run') {
    if (node.runPending) return 'running';
    if (node.runCompleted === '1' || node.runCompleted === true) return 'ready';
    return node.runResumable ? 'stopped' : 'missing';
  }
  if (node.processPending) return 'running';
  if (node.processResumable) return 'stopped';
  const result = parsed(node.dfResults, null);
  const outputs = result?.outputs && typeof result.outputs === 'object' ? result.outputs
    : (Array.isArray(result?.headers) ? { result } : null);
  return outputs && Object.keys(outputs).length ? 'ready' : 'missing';
}

const ACTIONS = { ready: 'reuse', stopped: 'resume', missing: 'run', running: 'run' };

function runPrompt(state, runId) {
  const edge = (state?.connections || []).find((item) => item?.type === 'prompt-to-run' && String(item.toId) === runId);
  const prompt = findNode(state, edge?.fromId);
  return prompt?.type === 'prompt' ? prompt : null;
}

function promptFormat(prompt) {
  const format = parsed(prompt?.outputFormat, null);
  if (Array.isArray(format)) return { fields: format, returnShape: prompt?.outputReturnShape || 'single' };
  return { fields: Array.isArray(format?.fields) ? format.fields : [], returnShape: format?.returnShape || 'single' };
}

/** Input rows a Run already finished, by their input row index. */
function doneRows(run) {
  const results = parsed(run.runResults, []);
  return new Set((Array.isArray(results) ? results : []).map((item) => item?.input_row_index).filter((index) => typeof index === 'number')).size;
}

/**
 * @param {object} state canvas state from getCanvasState()
 * @param {string} targetId a Run or Process node
 * @param {{ settings?: object, credentialIds?: Set<string> }} context Settings (default Run model,
 *   Python path) and the credentials that exist
 * @returns {{
 *   targetId: string,
 *   steps: Array<{ nodeId: string, kind: 'run'|'process', name: string, action: 'reuse'|'run'|'resume',
 *     inputRows: number|null, calls: number|null, credentialId?: string }>,
 *   inputs: Array<{ nodeId: string, name: string, rows: number|null, readBy: string[] }>,
 *   problems: Array<{ nodeId: string, message: string }>,
 *   toRun: number,
 *   calls: number|null,
 * }} steps upstream first; `calls` is model calls, null when some count is unknown; nothing may
 *   start while `problems` is not empty
 */
export function planRunTo(state, targetId, { settings = {}, credentialIds = new Set() } = {}) {
  const id = String(targetId || '').trim();
  const target = findNode(state, id);
  const plan = { targetId: id, steps: [], inputs: [], problems: [], toRun: 0, calls: 0 };
  const problem = (nodeId, message) => {
    if (!plan.problems.some((item) => item.nodeId === nodeId && item.message === message)) plan.problems.push({ nodeId, message });
  };
  if (!target || !STEP_TYPES.has(target.type)) {
    problem(id, 'Run to here works on Run and Process steps.');
    plan.calls = null;
    return plan;
  }

  // Walk upstream; post-order puts every step after the steps it reads.
  const order = [];
  const sourcesOf = new Map();
  const inputs = new Map();
  const seen = new Set();
  const visit = (nodeId) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = findNode(state, nodeId);
    const sources = stepSources(state, node);
    sourcesOf.set(nodeId, sources);
    for (const source of sources) {
      if (isStepSource(source) && findNode(state, source.nodeId)) visit(source.nodeId);
      else if (!isStepSource(source)) {
        if (!inputs.has(source.nodeId)) inputs.set(source.nodeId, []);
        if (!inputs.get(source.nodeId).includes(nodeId)) inputs.get(source.nodeId).push(nodeId);
      }
    }
    order.push(nodeId);
  };
  visit(id);

  // Rows each output gives, by source key: counted where the table exists, predicted where it will run.
  const rowsBySource = new Map();
  const rowsOf = (source) => {
    const key = sourceKey(source);
    if (rowsBySource.has(key)) return rowsBySource.get(key);
    const table = stepOutputTable(state, source).table;
    return table ? table.rows.length : null;
  };
  const actionOf = new Map();

  for (const nodeId of order) {
    const node = findNode(state, nodeId);
    const status = stepState(node);
    const action = ACTIONS[status];
    actionOf.set(nodeId, action);
    const name = stepSourceLabel(state, { nodeId, port: RESULT_PORT, kind: node.type });
    const sources = sourcesOf.get(nodeId);
    if (status === 'running') problem(nodeId, `"${name}" is already running.`);

    // What it reads must exist: a Dataset with content, a branch its upstream gives.
    for (const source of sources) {
      const upstream = findNode(state, source.nodeId);
      if (!isStepSource(source)) {
        if (stepOutputTable(state, source).waiting) problem(nodeId, stepInputWaitingMessage(state, source, 'no-result'));
        continue;
      }
      if (!upstream) {
        problem(nodeId, `"${name}" reads a step that is no longer on the canvas.`);
        continue;
      }
      if (actionOf.get(source.nodeId) === 'reuse') {
        if (stepOutputTable(state, source).waiting === 'missing-port') problem(nodeId, stepInputWaitingMessage(state, source, 'missing-port'));
      } else if (source.kind === 'process') {
        const known = effectiveProcessOutputs({ detected: upstream.processOutputPorts });
        if (known.source === 'code' && !known.dynamic && !known.ports.includes(source.port)) {
          problem(nodeId, stepInputWaitingMessage(state, source, 'missing-port'));
        }
      } else if (source.port !== RESULT_PORT) {
        problem(nodeId, stepInputWaitingMessage(state, source, 'missing-port'));
      }
    }

    const step = { nodeId, kind: node.type, name, action, inputRows: null, calls: null };
    if (node.type === 'run') {
      const source = sources[0];
      step.inputRows = source ? rowsOf(source) : null;
      step.credentialId = String(node.runCredentialId || settings.default_run_credential_id || '').trim();
      const prompt = runPrompt(state, nodeId);
      const format = promptFormat(prompt);
      if (action !== 'reuse') {
        if (!prompt) problem(nodeId, `"${name}" is not connected to a Prompt.`);
        else if (!format.fields.length) problem(nodeId, `Prompt "${String(prompt.name || '').trim() || 'Prompt'}" has no output fields.`);
        if (!source) problem(nodeId, `"${name}" has no input. Connect a Dataset or a step to it.`);
        const mapping = parsed(node.runInputToColumn, {});
        const unmapped = prompt ? extractInputFields(prompt.text).filter((field) => !String(mapping?.[field] || '').trim()) : [];
        if (unmapped.length) problem(nodeId, `"${name}" has no column mapped to ${unmapped.map((field) => `{${field}}`).join(', ')}.`);
        if (!step.credentialId || !credentialIds.has(step.credentialId)) problem(nodeId, `"${name}" has no usable model. Choose one in Settings → Run.`);
      }
      const done = action === 'resume' ? doneRows(node) : 0;
      step.calls = action === 'reuse' ? 0 : step.inputRows == null ? null : Math.max(0, step.inputRows - done);
      if (action !== 'reuse') {
        rowsBySource.set(sourceKey({ nodeId, port: RESULT_PORT, kind: 'run' }), format.returnShape === 'table' ? null : step.inputRows);
      }
    } else {
      const primary = sources.find((source) => source.primary) || sources[0] || null;
      step.inputRows = primary ? rowsOf(primary) : null;
      step.calls = 0;
      if (action !== 'reuse') {
        // A new Process gets its starting code when its window first opens.
        if (!processCode(node).trim()) problem(nodeId, `"${name}" has no code yet. Open it to write its code.`);
        else if (!/^\s*def\s+process\s*\(\s*df\b/m.test(processCode(node))) problem(nodeId, `"${name}" does not define process(df).`);
        if (!sources.length) problem(nodeId, `"${name}" has no df input. Connect a Dataset or a step to it.`);
        if (!String(settings.python_path || '').trim()) problem(nodeId, 'No Python interpreter is set. Choose one in Settings → Python.');
        // How many rows a Process returns is only known once it has run.
        for (const port of effectiveProcessOutputs({ detected: node.processOutputPorts }).ports.concat(RESULT_PORT)) {
          rowsBySource.set(sourceKey({ nodeId, port, kind: 'process' }), null);
        }
      }
    }
    plan.steps.push(step);
  }

  // Listed in the order the steps reading them run.
  const firstReader = (readBy) => Math.min(...readBy.map((stepId) => order.indexOf(stepId)));
  plan.inputs = [...inputs].sort((x, y) => firstReader(x[1]) - firstReader(y[1])).map(([nodeId, readBy]) => {
    const dataset = findNode(state, nodeId);
    const content = dataset?.datasetContent || dataset?.subsetContent;
    return {
      nodeId, name: String(dataset?.name || '').trim() || 'Dataset',
      rows: Array.isArray(content?.rows) ? content.rows.length : null, readBy,
    };
  });
  plan.toRun = plan.steps.filter((step) => step.action !== 'reuse').length;
  plan.calls = plan.steps.some((step) => step.kind === 'run' && step.calls == null)
    ? null : plan.steps.reduce((sum, step) => sum + (step.kind === 'run' ? step.calls : 0), 0);
  return plan;
}
