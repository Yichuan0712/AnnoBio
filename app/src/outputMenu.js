/** Shared creation and saving actions for node, branch and dropped-connection menus. */
import { effectiveProcessOutputs, showsProcessOutputs } from './processOutputPorts.js';
import { checkConnect, LINEAGE_PORT, nodePorts, PORT_TYPES } from './nodePorts.js';
import { samplerQuota, sampledOutputs } from './samplerQuota.js';

const RESULT = 'result';
const nodeIdOf = node => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find(node => nodeIdOf(node) === String(id || '').trim());
const parsed = (value, fallback) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const hasRunResults = run => {
  const rows = parsed(run?.runResults, []);
  return Array.isArray(rows) && rows.length > 0;
};
const item = (node, port, action, label, reason = '') => ({
  action, label, source: { nodeId: nodeIdOf(node), port, kind: node.type },
  ...(reason ? { disabled: true, disabledReason: reason } : {}),
});
const runSaveReason = node => !hasRunResults(node) ? 'Run this node first.'
  : !node.historyRecordId ? 'The results need a History record before they can be saved.' : '';
const processSaveReason = (node, branch) => {
  if (node.processPending) return 'Wait for processing to finish.';
  const result = parsed(node.dfResults, null);
  const outputs = result?.outputs || (Array.isArray(result?.rows) ? { result } : {});
  if (branch ? !outputs[branch] : !Object.keys(outputs).length) return 'Run this node to produce this output first.';
  return node.historyRecordId ? '' : 'The output needs a History record before it can be saved.';
};
const scoreReadyReason = (state, node) => {
  const runId = (state.connections || []).find(edge => edge.type === 'run-to-score' && edge.toId === nodeIdOf(node))?.fromId;
  if (!hasRunResults(findNode(state, runId))) return 'Run the upstream Run first.';
  if (findNode(state, node.scoreGroundTruthId)?.type !== 'dataset') return 'Connect a ground truth dataset first.';
  if (node.scoreMatchPending) return 'Wait for evaluation to finish.';
  return '';
};

function readers(node, ports, { named = false, dataset = false } = {}) {
  return [
    ...ports.map(port => item(node, port, 'run-prompt-on-output', dataset ? 'Create Run with this data'
      : named ? `Create Run from '${port}'` : 'Create Run from results')),
    ...ports.map(port => item(node, port, 'process-output', dataset ? 'Create Process'
      : named ? `Create Process from '${port}'` : 'Create Process from results')),
  ];
}

function creationItems(state, node) {
  if (node.type === 'dataset') return [
    item(node, LINEAGE_PORT, 'add-sampler', 'Create Sample'),
      item(node, LINEAGE_PORT, 'add-version-of-dataset', 'Create new version'),
  ];
  if (node.type === 'prompt') return [item(node, 'prompt', 'new-version', 'Create new version')];
  if (node.type === 'run') return [
    item(node, LINEAGE_PORT, 'save-to-workspace-and-score', 'Create Evaluate', hasRunResults(node) ? '' : 'Run this node first.'),
    item(node, LINEAGE_PORT, 'save-results-to-workspace', 'Save to workspace', runSaveReason(node)),
  ];
  if (node.type === 'process') return [item(node, LINEAGE_PORT, 'process-save-to-workspace', 'Save all outputs to workspace', processSaveReason(node))];
  if (node.type === 'score') return [
    item(node, LINEAGE_PORT, 'score-add-review', 'Optimize prompt', scoreReadyReason(state, node)),
    item(node, LINEAGE_PORT, 'score-save-to-workspace', 'Save to workspace', scoreReadyReason(state, node)),
  ];
  if (node.type === 'promptReview') {
    const result = parsed(node.reviewResult, {});
    const text = typeof result.workingText === 'string' ? result.workingText : result.promptText;
    return [item(node, LINEAGE_PORT, 'review-export', 'Create new Prompt',
      result.streamComplete === true && String(text || '').trim() ? '' : 'Finish optimization before creating a new Prompt.')];
  }
  if (node.type === 'sampler') {
    const sourceId = (state.connections || []).find(edge => edge.type === 'dataset-to-sampler' && edge.toId === nodeIdOf(node))?.fromId || node.sourceNodeId;
    const content = findNode(state, sourceId)?.datasetContent;
    let reason = !content?.rows?.length ? 'Connect a dataset with rows first.' : '';
    if (!reason && (node.samplingType || 'without-replacement') === 'without-replacement') {
      const quota = samplerQuota(content, sampledOutputs(state, nodeIdOf(node)), node.sampleSizeType || 'ratio', node.sampleSize ?? 100);
      if (quota.count < 1 || quota.availableIndices.length < quota.count) reason = 'There are not enough unused rows for another sample.';
    }
    return [item(node, LINEAGE_PORT, 'create-working-dataset', 'Create sample', reason)];
  }
  return [];
}

/** A node's output menu includes every applicable creation/save action; Process branches stay scoped. */
export function outputMenuItems(state, nodeId, { port } = {}) {
  const node = findNode(state, nodeId);
  if (!node) return [];
  const creation = creationItems(state, node);
  if (port === LINEAGE_PORT) return creation;
  let data = [];
  if (node.type === 'dataset' && (port === undefined || port === RESULT)) data = readers(node, [RESULT], { dataset: true });
  if (node.type === 'prompt' && (port === undefined || port === 'prompt')) data = [
    item(node, 'prompt', 'run-this-prompt', 'Create Run'), ...creation,
  ];
  if (node.type === 'run' && (port === undefined || port === RESULT)) data = [
    ...readers(node, [RESULT]), item(node, RESULT, 'save-results-to-workspace', 'Save to workspace', runSaveReason(node)),
  ];
  if (node.type === 'process') {
    const outputs = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
    const ports = port === undefined ? outputs.ports : outputs.ports.filter(name => name === port);
    data = readers(node, ports, { named: showsProcessOutputs(outputs) });
    if (port !== undefined && ports.length) data.push(item(node, port, 'process-save-to-workspace', 'Save to workspace', processSaveReason(node, port)));
  }
  if (node.type === 'score' && (port === undefined || port === 'score')) data = [
    item(node, 'score', 'score-save-to-workspace', 'Save to workspace', scoreReadyReason(state, node)),
  ];
  if (port !== undefined && !data.length) return [];
  const applicableCreation = port === undefined ? creation : node.type === 'process' ? []
    : creation.map(entry => ({ ...entry, source: { ...entry.source, port } }));
  const seen = new Set();
  return [...data, ...applicableCreation].filter(entry => {
    const key = `${entry.action}:${['run-prompt-on-output', 'process-output'].includes(entry.action) ? entry.source.port : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Upstream choices for an empty input, checked by the real connection rules. */
export function inputMenuItems(state, nodeId, portId) {
  const input = nodePorts(state, nodeId)?.inputs.find(port => port.id === portId);
  if (!input || input.fixed || input.source) return [];
  let newId = '__new_input__';
  while (findNode(state, newId)) newId += '_';
  const types = input.type === PORT_TYPES.PROMPT ? ['prompt'] : input.type === PORT_TYPES.TABLE
    ? (input.id === 'ground_truth' ? ['dataset'] : ['dataset', 'run', 'process']) : [];
  return types.map(type => {
    const sourcePort = type === 'prompt' ? 'prompt' : RESULT;
    const proposed = { type, nodeId: newId, processOutputPorts: { ports: [RESULT], dynamic: false, error: '', codeHash: 'new' } };
    const check = checkConnect({ ...state, nodes: [...state.nodes, proposed] }, { nodeId: newId, portId: sourcePort }, { nodeId, portId });
    return { ...item(proposed, sourcePort, 'create-input', `Create ${type === 'dataset' ? 'Dataset' : type === 'prompt' ? 'Prompt' : type === 'run' ? 'Run' : 'Process'}`, check.ok ? '' : check.reason), createType: type };
  });
}
