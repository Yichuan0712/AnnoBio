import { datasetSignature, processInputSignature, runInputSignature, sha256Signature } from './runHistorySignature.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const parsed = (value) => {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch (_) { return {}; }
};

/** Older Pipeline runs lack a frozen canvas definition. Recover it only when the current
 * executable node definitions still agree with that run's frozen compiler spec. */
export function withCompatibleLegacyCanvas(definition, currentCanvas) {
  if (definition?.canvas_state?.nodes) return definition;
  const spec = definition?.spec;
  if (!spec?.jobs || !currentCanvas?.nodes) return definition;
  const nodes = new Map(currentCanvas.nodes.map((node) => [node.nodeId, node]));
  for (const job of spec.jobs) {
    const ids = spec.source_map?.[job.id]?.node_ids || [];
    const target = nodes.get(ids.at(-1));
    if (job.type === 'process') {
      if (target?.type !== 'process' || String(target.dfCode || target.code || '') !== job.config.code) return definition;
    } else if (job.type === 'llm') {
      const prompt = nodes.get(ids[0]);
      if (target?.type !== 'run' || prompt?.type !== 'prompt'
        || target.runWorkingSetId !== String(job.inputs.data).replace(/^dataset:/, '')) return definition;
      const sections = (prompt.sections || []).map((section) => ({
        name: String(section.name || ''), content: String(section.content || ''),
      }));
      if (JSON.stringify(sections) !== JSON.stringify(job.config.sections || [])) return definition;
      const mapping = parsed(target.runInputToColumn);
      if (Object.entries(job.config.input_mapping || {}).some(([key, value]) => mapping[key] !== value)) return definition;
      const format = parsed(prompt.outputFormat);
      const fields = Array.isArray(format) ? format : format.fields || [];
      if ((format.returnShape || format.return_shape || 'single') !== job.config.output_schema?.return_shape
        || JSON.stringify(fields.map((field) => [field.key, field.type || 'str', !!(field.allowNone || field.allow_none)]))
          !== JSON.stringify((job.config.output_schema?.fields || []).map((field) => [field.key, field.type || 'str', !!field.allow_none]))) return definition;
    }
  }
  for (const artifact of spec.artifacts || []) {
    const id = String(artifact.id).replace(/^dataset:/, '');
    if (artifact.id.startsWith('dataset:') && nodes.get(id)?.type !== 'dataset') return definition;
  }
  return { ...definition, canvas_state: {
    nodes: copy(currentCanvas.nodes), connections: copy(currentCanvas.connections || []),
  } };
}

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

/** Job inputs that move onto the Dataset copies a Pipeline run published: a Run's Dataset, or a
 * Process's primary `df`. Other Process inputs are bound by `df_<name>` aliases the Process code
 * derives from Dataset names, which a copy cannot take over, so such a Process stays as it is.
 * @param {Map<string, string>} copyIds logical artifact id -> published copy node id
 * @returns {Map<string, Map<string, string>>} job id -> (logical artifact id -> copy node id) */
export function pipelineCopyInputs(spec, copyIds) {
  const moves = new Map();
  for (const job of spec?.jobs || []) {
    if (job.type !== 'llm' && job.type !== 'process') continue;
    const inputs = Object.entries(job.inputs || {}).filter(([, logicalId]) => copyIds.has(logicalId));
    if (!inputs.length || (job.type === 'process' && inputs.some(([alias]) => alias !== 'df'))) continue;
    moves.set(job.id, new Map(inputs.map(([, logicalId]) => [logicalId, copyIds.get(logicalId)])));
  }
  return moves;
}

async function recordId(runId, nodeId) {
  const signature = await sha256Signature({ pipelineRunId: runId, nodeId });
  return signature.slice('sha256:'.length, 'sha256:'.length + 32);
}

/** Import completed Pipeline jobs into the same Run/Process History used by node detail views.
 * Every input is read from the Pipeline's immutable artifacts, never from a possibly edited canvas.
 * Deterministic record IDs make retries and project reopen safe.
 * `inputCopies` (job id -> logical id -> {nodeId, name, content}) records an input as the published
 * Dataset copy its consumer is moved onto (pipelineCopyInputs), with the copy's canvas content. */
export async function importPipelineRunHistory({ run, definition, getArtifact, session, inputCopies = new Map() }) {
  if (!session?.projectId || !definition?.canvas_state?.nodes || !definition?.spec?.jobs) {
    throw new Error('This Pipeline run has no frozen node definition for History import.');
  }
  const { spec, canvas_state: canvas } = definition;
  const nodes = new Map(canvas.nodes.map((node) => [node.nodeId, node]));
  const artifacts = new Map(spec.artifacts.map((artifact) => [artifact.id, artifact]));
  const states = new Map((run.jobs || []).map((job) => [job.job_id, job]));
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
  const inputSnapshot = async (logicalId, jobId) => {
    const artifact = artifacts.get(logicalId);
    const datasetId = String(logicalId).replace(/^dataset:/, '');
    const dataset = nodes.get(datasetId);
    if (!artifact || !dataset || dataset.type !== 'dataset') throw new Error(`Pipeline Dataset definition is missing: ${logicalId}`);
    const producer = artifact.producer;
    const upstreamPipelineRecordId = producer ? imported.get(producer.job_id) : null;
    const published = inputCopies.get(jobId)?.get(logicalId);
    if (published) {
      // A saved copy: signed by its content, exactly as the canvas holds it.
      return {
        nodeId: published.nodeId, name: published.name || published.nodeId, content: copy(published.content),
        signature: await datasetSignature({ nodeId: published.nodeId, content: published.content }),
        ...(upstreamPipelineRecordId ? { upstreamPipelineRecordId } : {}),
      };
    }
    const content = await getTable(logicalId);
    const sourceRecordId = !dataset.savedCopy ? upstreamPipelineRecordId : null;
    const sourceIds = sourceRecordId ? spec.source_map?.[producer.job_id]?.node_ids || [] : [];
    const sourceNodeId = sourceIds.at(-1);
    const branch = producer?.port || 'result';
    return {
      nodeId: datasetId, name: dataset.name || datasetId, content: copy(content),
      signature: await datasetSignature({ nodeId: datasetId, content,
        ...(sourceRecordId ? { sourceRecordId, branch } : {}) }),
      ...(upstreamPipelineRecordId ? { upstreamPipelineRecordId } : {}),
      ...(sourceRecordId ? { sourceRecordId, sourceNodeId, branch } : {}),
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
    const sourceRecordIds = new Set();
    let record;
    if (job.type === 'llm') {
      const promptId = sourceIds[0];
      const prompt = nodes.get(promptId);
      const input = await inputSnapshot(job.inputs.data, job.id);
      if (!prompt || prompt.type !== 'prompt') throw new Error(`Pipeline Prompt definition is missing: ${promptId}`);
      if (input.upstreamPipelineRecordId) sourceRecordIds.add(input.upstreamPipelineRecordId);
      const promptSnapshot = {
        nodeId: promptId, name: prompt.name || '', sections: copy(prompt.sections || []),
        outputFormat: copy(prompt.outputFormat || { returnShape: 'single', fields: [] }),
        inputTypes: copy(prompt.inputTypes || {}),
      };
      const mapping = copy(parsed(nodes.get(nodeId)?.runInputToColumn));
      const fields = job.config.output_schema?.fields || [];
      const outputId = (job.outputs?.result || [])[0];
      const output = await getTable(outputId);
      const results = runResults(output, input.content.headers.length, fields);
      const model = (run.plan?.jobs || []).find((item) => item.job_id === job.id)?.model?.model || '';
      record = {
        id, nodeId, kind: 'run', status: 'completed', createdAt: at, updatedAt: at,
        signature: await runInputSignature({ promptNodeId: promptId, prompt: promptSnapshot,
          datasetNodeId: input.nodeId, datasetSignature: input.signature, mapping }),
        inputs: { prompt: promptSnapshot, dataset: input, mapping,
          settings: copy(job.config.settings || {}),
          credentialId: (run.plan?.jobs || []).find((item) => item.job_id === job.id)?.model?.credential_id || '' },
        results: { runResults: results, runInputContent: copy(input.content),
          runOutputFields: fields.map((field) => ({ key: field.key, display: field.display || field.key })),
          runProgress: 100 },
        sourceRecordIds: [...sourceRecordIds], model,
        summary: { promptName: promptSnapshot.name, datasetNames: [input.name],
          rowCount: input.content.rows.length, errorCount: 0, model },
        pipelineRunId: run.run_id,
      };
    } else if (job.type === 'process') {
      const bindings = [];
      for (const [alias, logicalId] of Object.entries(job.inputs || {})) {
        const snapshot = await inputSnapshot(logicalId, job.id);
        if (snapshot.upstreamPipelineRecordId) sourceRecordIds.add(snapshot.upstreamPipelineRecordId);
        bindings.push({ ...snapshot, alias });
      }
      const primary = bindings.find((item) => item.alias === 'df') || bindings[0];
      if (!primary) throw new Error(`Pipeline Process has no input: ${job.id}`);
      const outputs = {};
      for (const [port, ids] of Object.entries(job.outputs || {})) {
        outputs[port] = await getTable(ids[0]);
      }
      const code = String(job.config.code || '');
      record = {
        id, nodeId, kind: 'process', status: 'completed', createdAt: at, updatedAt: at,
        signature: await processInputSignature({ code, primaryDatasetId: primary.nodeId, bindings }),
        inputs: { code, primaryDatasetId: primary.nodeId, bindings },
        results: { dfResults: { outputs } }, sourceRecordIds: [...sourceRecordIds],
        summary: { codeLine: code.split('\n')[0].trim(), datasetNames: bindings.map((item) => item.name) },
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
