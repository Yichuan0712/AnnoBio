/**
 * The menu items that start a new node on a node's output (docs/design/DATA_FLOW_DESIGN.md §5.2,
 * NODE_PORTS_PLAN.md step 4): the start of a node's right-click menu, the menu of a Process branch,
 * and the menu shown when a line dragged from an output is let go over empty canvas. Pure; works on
 * canvas state as getCanvasState() saves it.
 */
import { effectiveProcessOutputs, showsProcessOutputs } from './processOutputPorts.js';

const RESULT = 'result';
const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());

function hasRunResults(run) {
  let results = run?.runResults;
  if (typeof results === 'string') {
    try { results = JSON.parse(results || '[]'); } catch (_) { results = []; }
  }
  return Array.isArray(results) && results.length > 0;
}

/** Items for one output port of a Run, Process or Dataset: a new Run and a new Process reading it. */
function readerItems(sources, { named, dataset }) {
  return [
    ...sources.map((source) => ({
      action: 'run-prompt-on-output',
      label: dataset ? 'Run a prompt on it' : named ? `Run a prompt on '${source.port}'` : 'Run a prompt on results',
      source,
    })),
    ...(dataset ? [{ action: 'add-sampler', label: 'Sample', source: sources[0] }] : []),
    ...sources.map((source) => ({
      action: 'process-output',
      label: dataset ? 'Process with code' : named ? `Process '${source.port}' with code` : 'Process results with code',
      source,
    })),
  ];
}

/**
 * What can be started on a node's output, in menu order. A Run and a Process are offered their
 * readers before they have a result, so a pipeline can be built first and run afterwards; a Score
 * and a Review need results, as the node menus always required. With `port`, only that output's
 * items: a Process branch, or the one output of any other node.
 * @param {object} state canvas state
 * @param {string} nodeId
 * @param {{ port?: string }} [options]
 * @returns {Array<{ action: 'run-prompt-on-output' | 'process-output' | 'add-sampler' | 'run-this-prompt'
 *   | 'save-to-workspace-and-score' | 'score-add-review', label: string, source: { nodeId: string, port: string, kind: string },
 *   disabled?: boolean }>}
 */
export function outputMenuItems(state, nodeId, { port } = {}) {
  const node = findNode(state, nodeId);
  if (!node) return [];
  const id = nodeIdOf(node);
  const single = (outputPort) => (port === undefined || port === outputPort);
  if (node.type === 'dataset') {
    return single(RESULT) ? readerItems([{ nodeId: id, port: RESULT, kind: 'dataset' }], { dataset: true }) : [];
  }
  if (node.type === 'prompt') {
    return single('prompt') ? [{ action: 'run-this-prompt', label: 'Run', source: { nodeId: id, port: 'prompt', kind: 'prompt' } }] : [];
  }
  if (node.type === 'run') {
    if (!single(RESULT)) return [];
    const source = { nodeId: id, port: RESULT, kind: 'run' };
    return [
      ...readerItems([source], { named: false }),
      { action: 'save-to-workspace-and-score', label: 'Score', source, disabled: !hasRunResults(node) },
    ];
  }
  if (node.type === 'process') {
    const outputs = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
    const ports = port === undefined ? outputs.ports : outputs.ports.filter((item) => item === port);
    return readerItems(ports.map((item) => ({ nodeId: id, port: item, kind: 'process' })), { named: showsProcessOutputs(outputs) });
  }
  if (node.type === 'score') {
    if (!single('score')) return [];
    const runId = (state?.connections || []).find((edge) => edge?.type === 'run-to-score' && String(edge.toId) === id)?.fromId;
    const ready = hasRunResults(findNode(state, runId)) && !!String(node.scoreGroundTruthId || '').trim();
    return [{ action: 'score-add-review', label: 'Review', source: { nodeId: id, port: 'score', kind: 'score' }, disabled: !ready }];
  }
  return [];
}
