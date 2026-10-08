import { datasetSignature, processInputSignature, runInputSignature, sha256Signature, stepOutputSignature } from './runHistorySignature.js';
import { upgradeCanvasState } from './canvasFormat.js';
import { sourceKey, stepSourceLabel } from './stepInputs.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const parsed = (value) => {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch (_) { return {}; }
};

export const PIPELINE_RUN_BEFORE_DATA_FLOW = 'This run was made before steps connected directly; its results are not added to node History.';

function tableContent(table) {
  if (!Array.isArray(table?.headers) || !Array.isArray(table?.rows)) throw new Error('Pipeline artifact has no table.');
  return {
    headers: copy(table.headers), rows: copy(table.rows),
    columnTypes: copy(table.column_types || table.columnTypes || []),
    rowIds: copy(table.row_ids || table.rowIds || []),
  };
}

function runResults(table, inputColumnCount, fields) {
  return table.rows.map((row, index) => ({
    input_row_index: Math.max(0, Number(row[0] || 1) - 1),
    row_index: Math.max(0, Number(row[inputColumnCount + 1] || index + 1) - 1),
    input_row: copy(row.slice(1, inputColumnCount + 1)),
    output: Object.fromEntries(fields.map((field, fieldIndex) => [field.key, row[inputColumnCount + 2 + fieldIndex]])),
  }));
}

async function recordId(runId, nodeId) {
  const signature = await sha256Signature({ pipelineRunId: runId, nodeId });
  return signature.slice('sha256:'.length, 'sha256:'.length + 32);
}

/** Whether node History already holds a run: a record for every job that succeeded. Record IDs
 * follow from the run and the node (recordId), and job IDs are `llm:<Run node>` and
 * `process:<Process node>`, so no record has to be loaded. */
export async function pipelineRunImported(run, index) {
  const nodeIds = (run?.jobs || []).filter((job) => job?.status === 'succeeded')
    .map((job) => String(job.job_id || '').match(/^(?:llm|process):(.+)$/)?.[1]).filter(Boolean);
  if (!run?.run_id || !nodeIds.length) return false;
  const ids = new Set((index?.records || []).map((entry) => entry.id));
  for (const nodeId of nodeIds) if (!ids.has(await recordId(run.run_id, nodeId))) return false;
  return true;
}

/** Import completed Pipeline jobs into the same Run/Process History used by node detail views, as
 * records exactly like a single-node run's plus `pipelineRunId` (docs/design/DATA_FLOW_DESIGN.md §3.8):
 * an entry Dataset is kept as its content, read from the run's immutable artifact and never from a
 * possibly edited canvas; a step's output as a reference to the record its job was imported as.
 * Jobs come in dependency order, so that record is already there. Deterministic record IDs make
 * retries and project reopen safe. */
export async function importPipelineRunHistory({ run, definition, getArtifact, session }) {
  if (!session?.projectId || !definition?.canvas_state?.nodes || !definition?.spec?.jobs) {
    throw new Error('This Pipeline run has no frozen node definition for History import.');
  }
  const { spec } = definition;
  // Before steps connected directly, a run's intermediate results were Datasets with a producer.
  if ((spec.artifacts || []).some((artifact) => String(artifact.id).startsWith('dataset:') && artifact.producer)) {
    throw new Error(PIPELINE_RUN_BEFORE_DATA_FLOW);
  }
  // A Pipeline started before canvas version 3 froze its canvas in the older format.
  const canvas = upgradeCanvasState(definition.canvas_state);
  const nodes = new Map(canvas.nodes.map((node) => [node.nodeId, node]));
  const artifacts = new Map(spec.artifacts.map((artifact) => [artifact.id, artifact]));
  const jobs = new Map(spec.jobs.map((job) => [job.id, job]));
  const states = new Map((run.jobs || []).map((job) => [job.job_id, job]));
  const jobNodeId = (jobId) => spec.source_map?.[jobId]?.node_ids?.at(-1);
  const imported = new Map();
  const tables = new Map();
  const getTable = async (logicalId) => {
    if (!tables.has(logicalId)) {
      const result = await getArtifact(logicalId);
      if (!result?.artifact?.valid || !result?.table) throw new Error(`Pipeline artifact is unavailable: ${logicalId}`);
      tables.set(logicalId, tableContent(result.table));
    }
    return tables.get(logicalId);
  };
  /** One job input as a source (stepInputs.js) and the snapshot its record keeps. */
  const inputSnapshot = async (logicalId) => {
    const artifact = artifacts.get(logicalId);
    if (!artifact) throw new Error(`Pipeline artifact definition is missing: ${logicalId}`);
    if (!artifact.producer) {
      const nodeId = String(logicalId).replace(/^dataset:/, '');
      const dataset = nodes.get(nodeId);
      if (!dataset || dataset.type !== 'dataset') throw new Error(`Pipeline Dataset definition is missing: ${logicalId}`);
      const content = await getTable(logicalId);
      return {
        source: { nodeId, kind: 'dataset' },
        snapshot: { kind: 'dataset', nodeId, name: dataset.name || '', content: copy(content),
          signature: await datasetSignature({ nodeId, content }) },
      };
    }
    const { job_id: jobId, port } = artifact.producer;
    const nodeId = jobNodeId(jobId);
    const upstreamRecordId = imported.get(jobId);
    if (!nodeId || !upstreamRecordId) throw new Error(`Pipeline upstream result is missing: ${logicalId}`);
    return {
      source: { nodeId, port, kind: jobs.get(jobId)?.type === 'llm' ? 'run' : 'process' },
      snapshot: { kind: 'step', nodeId, port, recordId: upstreamRecordId,
        signature: await stepOutputSignature({ nodeId, recordId: upstreamRecordId, port }) },
    };
  };
  let count = 0;
  for (const job of spec.jobs) {
    if (states.get(job.id)?.status !== 'succeeded') continue;
    const sourceIds = spec.source_map?.[job.id]?.node_ids || [];
    const nodeId = sourceIds.at(-1);
    if (!nodeId) throw new Error(`Pipeline job has no canvas node: ${job.id}`);
    const id = await recordId(run.run_id, nodeId);
    const existing = session.index.records.find((item) => item.id === id);
    if (existing) {
      if (existing.nodeId !== nodeId || existing.kind !== (job.type === 'llm' ? 'run' : 'process')) {
        throw new Error(`Pipeline History record ID conflicts: ${id}`);
      }
      imported.set(job.id, id);
      continue;
    }
    const at = states.get(job.id)?.finished_at || run.finished_at || run.updated_at || new Date().toISOString();
    let record;
    if (job.type === 'llm') {
      const promptId = sourceIds[0];
      const prompt = nodes.get(promptId);
      if (!prompt || prompt.type !== 'prompt') throw new Error(`Pipeline Prompt definition is missing: ${promptId}`);
      const { source, snapshot: dataset } = await inputSnapshot(job.inputs.data);
      const table = await getTable(job.inputs.data);
      const promptSnapshot = {
        nodeId: promptId, name: prompt.name || '', sections: copy(prompt.sections || []),
        outputFormat: copy(prompt.outputFormat || { returnShape: 'single', fields: [] }),
        inputTypes: copy(prompt.inputTypes || {}),
      };
      const mapping = copy(parsed(nodes.get(nodeId)?.runInputToColumn));
      const fields = job.config.output_schema?.fields || [];
      const output = await getTable((job.outputs?.result || [])[0]);
      const planned = (run.plan?.jobs || []).find((item) => item.job_id === job.id)?.model || {};
      const model = planned.model || '';
      record = {
        id, nodeId, kind: 'run', status: 'completed', createdAt: at, updatedAt: at,
        signature: await runInputSignature({ promptNodeId: promptId, prompt: promptSnapshot,
          datasetNodeId: sourceKey(source), datasetSignature: dataset.signature, mapping }),
        inputs: { prompt: promptSnapshot, dataset, mapping,
          settings: copy(job.config.settings || {}), credentialId: planned.credential_id || '' },
        results: { runResults: runResults(output, table.headers.length, fields), runInputContent: copy(table),
          runOutputFields: fields.map((field) => ({ key: field.key, display: field.display || field.key })),
          runProgress: 100 },
        sourceRecordIds: dataset.recordId ? [dataset.recordId] : [], model,
        summary: { promptName: promptSnapshot.name, datasetNames: [dataset.name || stepSourceLabel(canvas, source)],
          rowCount: table.rows.length, errorCount: 0, model },
        pipelineRunId: run.run_id,
      };
    } else if (job.type === 'process') {
      const inputs = [];
      for (const [alias, logicalId] of Object.entries(job.inputs || {})) {
        const { source, snapshot } = await inputSnapshot(logicalId);
        inputs.push({ source, binding: { ...snapshot, alias } });
      }
      const primary = inputs.find((item) => item.binding.alias === 'df') || inputs[0];
      if (!primary) throw new Error(`Pipeline Process has no input: ${job.id}`);
      const bindings = inputs.map((item) => item.binding);
      const primaryDatasetId = sourceKey(primary.source);
      const outputs = {};
      for (const [port, ids] of Object.entries(job.outputs || {})) {
        outputs[port] = await getTable(ids[0]);
      }
      const code = String(job.config.code || '');
      record = {
        id, nodeId, kind: 'process', status: 'completed', createdAt: at, updatedAt: at,
        signature: await processInputSignature({ code, primaryDatasetId,
          bindings: inputs.map((item) => ({ ...item.binding, key: sourceKey(item.source) })) }),
        inputs: { code, primaryDatasetId, bindings },
        results: { dfResults: { outputs } },
        sourceRecordIds: [...new Set(bindings.map((item) => item.recordId).filter(Boolean))],
        summary: { codeLine: code.split('\n')[0].trim(),
          datasetNames: inputs.map((item) => item.binding.name || stepSourceLabel(canvas, item.source)) },
        pipelineRunId: run.run_id,
      };
    } else {
      continue;
    }
    await session.putRecord(record);
    imported.set(job.id, id);
    count += 1;
  }
  return { imported: count, recordIdsByJob: imported };
}
