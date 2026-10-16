/**
 * Datasets saved from a step's output (docs/design/DATA_FLOW_DESIGN.md §3.6). A saved Dataset is a
 * plain Dataset; `savedFrom` only records where it came from, for its note and the line drawn from
 * that node. Pipelines and History never read it. Pure; works on canvas state as getCanvasState()
 * saves it, so the canvas windows, the context menu and the Agent save the same tables.
 */
import { generateDisplayName } from './nodeLabels.js';
import { stepOutputTable, runResultsTable } from './stepOutputs.js';

const RESULT = 'result';
const KINDS = new Set(['run', 'process', 'score', 'pipeline']);
const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/**
 * `savedFrom` as an object (the DOM keeps it as JSON), or null when there is none.
 * @returns {{ kind: 'run'|'process'|'score'|'pipeline', nodeId: string, port: string, recordId: string, pipelineRunId?: string } | null}
 */
export function readSavedFrom(value) {
  const item = parsed(value, null);
  if (!item || typeof item !== 'object' || !KINDS.has(item.kind)) return null;
  return {
    kind: item.kind, nodeId: String(item.nodeId || ''), port: String(item.port || RESULT), recordId: String(item.recordId || ''),
    ...(item.pipelineRunId ? { pipelineRunId: String(item.pipelineRunId) } : {}),
  };
}

function promptOf(state, runId) {
  const edge = (state?.connections || []).find((item) => item?.type === 'prompt-to-run' && String(item.toId) === runId);
  return findNode(state, edge?.fromId);
}

/**
 * A Generate's results as a new Dataset: the table its readers get (stepOutputs.js), with its input
 * columns, also from a Generate that stopped part way.
 * @returns {{ name: string, notes: string, table: { headers, rows, columnTypes }, savedFrom: object }}
 */
export function savedRunOutput(state, runId) {
  const run = findNode(state, runId);
  if (!run || run.type !== 'run') throw new Error('Generate node was not found.');
  const table = runResultsTable(state, run);
  if (!table?.rows.length) throw new Error('This Generate has no results yet.');
  const recordId = String(run.historyRecordId || '').trim();
  if (!recordId) throw new Error('This Generate has no History record yet. Run it again before saving its results.');
  const promptName = String(promptOf(state, nodeIdOf(run))?.name || '').trim() || 'Prompt';
  const runName = generateDisplayName(run.runName);
  const completed = run.runCompleted === '1' || run.runCompleted === true;
  return {
    name: `${promptName} ${runName}`,
    notes: `Exported from ${promptName} ${runName}.\n${completed ? 'Run completed.' : 'Run incomplete.'}`,
    table: { headers: table.headers, rows: table.rows, columnTypes: table.columnTypes },
    savedFrom: { kind: 'run', nodeId: nodeIdOf(run), port: RESULT, recordId },
  };
}

/**
 * Each branch of a Process's current result as a new Dataset, in the order the Process returns them.
 * `branch` selects just the opened branch; `snapshot` keeps a detail view's displayed History result.
 * @returns {Array<{ port: string, name: string, notes: string, table: { headers, rows, columnTypes }, savedFrom: object }>}
 */
export function savedProcessOutputs(state, processId, { branch, snapshot } = {}) {
  let processNode = findNode(state, processId);
  if (!processNode || processNode.type !== 'process') throw new Error('Process node was not found.');
  if (snapshot) {
    processNode = { ...processNode, dfResults: snapshot.results, historyRecordId: snapshot.recordId, processPending: false, processResumable: false };
    state = { ...state, nodes: state.nodes.map((node) => nodeIdOf(node) === nodeIdOf(processNode) ? processNode : node) };
  }
  const result = parsed(processNode.dfResults, null);
  const outputs = result?.outputs && typeof result.outputs === 'object'
    ? result.outputs : (Array.isArray(result?.headers) && Array.isArray(result?.rows) ? { result } : {});
  const ports = Object.keys(outputs);
  if (!ports.length) throw new Error('This Process has no output yet. Run it first.');
  if (branch !== undefined && !ports.includes(branch)) throw new Error(`This Process has no "${branch}" output.`);
  const recordId = String(processNode.historyRecordId || '').trim();
  if (!recordId) throw new Error('This Process has no History record yet. Run it again before saving its output.');
  const title = String(processNode.name || '').trim() || 'Process';
  return (branch === undefined ? ports : [branch]).map((port) => {
    const output = stepOutputTable(state, { nodeId: nodeIdOf(processNode), port, kind: 'process' });
    if (!output.table) throw new Error(output.waiting === 'running' ? 'This Process is still running.' : `This Process has no "${port}" output.`);
    return {
      port,
      name: ports.length === 1 ? `${title} results` : `${title} — ${port}`,
      notes: `Branch "${port}" exported from Process "${title}".`,
      table: { headers: output.table.headers, rows: output.table.rows, columnTypes: output.table.columnTypes },
      savedFrom: { kind: 'process', nodeId: nodeIdOf(processNode), port, recordId },
    };
  });
}

/** A Score's comparison saved as a Dataset; `recordId` is its current Score record, if it has one. */
export function scoreSavedFrom(scoreNodeId, recordId = '') {
  return { kind: 'score', nodeId: String(scoreNodeId || ''), port: RESULT, recordId: String(recordId || '') };
}

/** "Saved from …": what the line from the source node says, naming it as the canvas does. */
export function savedFromLabel(state, savedFrom) {
  const from = readSavedFrom(savedFrom);
  if (!from) return '';
  const node = findNode(state, from.nodeId);
  let step = '';
  if (node?.type === 'run') step = `Generate using "${String(promptOf(state, nodeIdOf(node))?.name || '').trim() || 'Prompt'}"`;
  else if (node?.type === 'process') {
    const name = `Process "${String(node.name || '').trim() || 'Process'}"`;
    step = from.port === RESULT ? name : `branch "${from.port}" of ${name}`;
  } else if (node?.type === 'score') step = `Evaluate "${String(node.scoreName || node.name || '').trim() || 'Evaluate'}"`;
  if (from.kind === 'pipeline') return `Saved from a Pipeline run${step ? ` (${step})` : ''}`;
  return step ? `Saved from ${step}` : '';
}
