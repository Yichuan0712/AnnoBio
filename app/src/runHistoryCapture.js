import { datasetSignature, processInputSignature, runInputSignature, stepOutputSignature } from './runHistorySignature.js';
import { resolveHistoryCanvasState } from './runHistoryResolver.js';
import { processRequiredInputs, runInputSource, sourceKey, stepInputWaitingMessage, stepSourceLabel } from './stepInputs.js';
import { stepOutputTable } from './stepOutputs.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const nodeId = (node) => String(node?.nodeId || node?.id || '');

function parsed(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/**
 * Freeze exactly the inputs used by one new Generate/Process record (docs/design/DATA_FLOW_DESIGN.md §3.8).
 * A Dataset input is kept as a snapshot of its content; a step's output only as a reference to the
 * upstream record, which cannot change. A Generate's capture also carries `inputTable`, the table it reads,
 * which runningHistoryRecord keeps as the record's runInputContent and not as an input.
 */
export async function captureHistoryInput(state, targetNodeId, { index, loadRecord }) {
  const resolved = await resolveHistoryCanvasState(state, { index, loadRecord });
  const canvas = resolved.state;
  const nodes = new Map(canvas.nodes.map((node) => [nodeId(node), node]));
  const target = nodes.get(targetNodeId);
  if (!target || !['run', 'process'].includes(target.type)) throw new Error(`Generate or Process node was not found: ${targetNodeId}`);

  async function snapshotDataset(id) {
    const dataset = nodes.get(id);
    const content = dataset?.type === 'dataset' ? dataset.datasetContent || dataset.subsetContent : null;
    if (!content || !Array.isArray(content.rows)) throw new Error(`Input Dataset is missing: ${id}`);
    return {
      kind: 'dataset', nodeId: id, name: dataset.name || '', content: copy(content),
      signature: await datasetSignature({ nodeId: id, content }),
    };
  }

  /** One input: a Dataset snapshot, or a reference to the current record of the step it reads. */
  async function snapshotSource(source) {
    if (source?.kind !== 'run' && source?.kind !== 'process') {
      const snapshot = await snapshotDataset(source?.nodeId || '');
      return { snapshot, table: snapshot.content };
    }
    const output = stepOutputTable(canvas, source);
    const recordId = resolved.currentRecordIds[source.nodeId];
    if (!output.table || !recordId) throw new Error(stepInputWaitingMessage(canvas, source, output.waiting || 'no-result'));
    return {
      snapshot: {
        kind: 'step', nodeId: source.nodeId, port: source.port, recordId,
        signature: await stepOutputSignature({ nodeId: source.nodeId, recordId, port: source.port }),
      },
      table: output.table,
    };
  }

  if (target.type === 'run') {
    const promptEdge = canvas.connections.find((edge) => edge.type === 'prompt-to-run' && edge.toId === targetNodeId);
    const prompt = nodes.get(promptEdge?.fromId);
    if (!prompt || prompt.type !== 'prompt') throw new Error('Generate has no input Prompt.');
    const source = runInputSource(canvas, targetNodeId);
    const { snapshot: dataset, table } = await snapshotSource(source);
    const promptSnapshot = {
      nodeId: nodeId(prompt), name: prompt.name || '', text: String(prompt.text || ''),
      outputFormat: copy(prompt.outputFormat || { returnShape: 'single', fields: [] }),
      inputTypes: copy(prompt.inputTypes || {}),
    };
    const mapping = parsed(target.runInputToColumn, {});
    const signature = await runInputSignature({
      promptNodeId: promptSnapshot.nodeId, prompt: promptSnapshot, datasetNodeId: sourceKey(source),
      datasetSignature: dataset.signature, mapping,
    });
    const upstreamRecordId = dataset.recordId;
    return {
      nodeId: targetNodeId, kind: 'run', signature,
      inputs: {
        prompt: promptSnapshot, dataset, mapping: copy(mapping),
        settings: copy(target.runSettings || {}), credentialId: target.runCredentialId || '',
      },
      sourceRecordIds: upstreamRecordId ? [upstreamRecordId] : [],
      summary: {
        promptName: promptSnapshot.name, datasetNames: [dataset.name || stepSourceLabel(canvas, source)],
        rowCount: Array.isArray(table?.rows) ? table.rows.length : 0,
      },
      inputTable: copy(table),
    };
  }

  const code = String(target.dfCode || target.code || '');
  const { primaryId: primaryDatasetId, bindings: required } = processRequiredInputs(canvas, targetNodeId, { code });
  if (!primaryDatasetId) throw new Error('Process has no input Dataset.');
  if (!code.trim()) throw new Error('Process has no code.');
  const bindings = [];
  for (const binding of required) {
    const { snapshot } = await snapshotSource(binding);
    bindings.push({ ...snapshot, alias: binding.alias });
  }
  if (!required.some((binding) => binding.key === primaryDatasetId)) throw new Error('Process primary Dataset is missing.');
  return {
    nodeId: targetNodeId, kind: 'process',
    signature: await processInputSignature({
      code, primaryDatasetId, bindings: bindings.map((item, index) => ({ ...item, key: required[index].key })),
    }),
    inputs: { code, primaryDatasetId, bindings },
    sourceRecordIds: [...new Set(bindings.map((item) => item.recordId).filter(Boolean))],
    summary: {
      codeLine: code.split('\n')[0].trim(),
      datasetNames: bindings.map((item, index) => item.name || stepSourceLabel(canvas, required[index])),
    },
  };
}

export function runningHistoryRecord(capture, {
  createId = () => globalThis.crypto.randomUUID().replaceAll('-', ''),
  now = () => new Date().toISOString(),
} = {}) {
  const { inputTable, ...record } = capture;
  const at = now();
  return {
    ...record, id: createId(), status: 'running', createdAt: at, updatedAt: at,
    results: capture.kind === 'run'
      ? { runResults: [], runInputContent: copy(inputTable || capture.inputs.dataset.content), runOutputFields: [], runProgress: 0 }
      : { dfResults: null },
  };
}
