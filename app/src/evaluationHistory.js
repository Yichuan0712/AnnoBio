import { analysisInputKeys } from './runAnalysisHistory.js';
import { resolveHistoryCanvasState } from './runHistoryResolver.js';

const copy = value => JSON.parse(JSON.stringify(value));
const parsed = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };

/** Capture all evaluation inputs before doing any asynchronous matching. */
export async function captureEvaluation(state, nodeId, { currentRecordIds, loadRecord }) {
  const node = state.nodes.find(item => item.nodeId === nodeId && item.type === 'score');
  if (!node) throw new Error('Evaluate node was not found.');
  const key = (await analysisInputKeys(state, currentRecordIds)).score.get(nodeId);
  if (!key) throw new Error('Run Generate and select a ground truth Dataset before running Evaluate.');
  const run = await loadRecord(key.inputs.runRecordId);
  if (!run || run.kind !== 'run' || run.status !== 'completed') throw new Error('Wait for Generate to finish before running Evaluate.');
  const groundTruth = state.nodes.find(item => item.nodeId === key.inputs.groundTruthId && item.type === 'dataset');
  const runNodeId = state.connections.find(edge => edge.type === 'run-to-score' && edge.toId === nodeId)?.fromId;
  const input = run.results?.runInputContent || run.inputs?.dataset?.content;
  if (!input || !groundTruth?.datasetContent) throw new Error('The evaluation input snapshot is incomplete.');
  return {
    nodeId, kind: 'score', evaluationVersion: 1, signature: key.signature,
    sourceRecordIds: [run.id],
    inputs: copy({ ...key.inputs, runNodeId,
      groundTruth: { nodeId: groundTruth.nodeId, name: groundTruth.name || '', content: groundTruth.datasetContent },
      prompt: run.inputs.prompt, input, runResults: run.results.runResults || [], outputFields: run.results.runOutputFields || [],
      runMapping: run.inputs.mapping || {}, runCredentialId: run.credentialId || run.inputs.credentialId || '', runSettings: run.inputs.settings || {},
    }),
    summary: { name: node.scoreName || 'Evaluate', runName: run.summary?.promptName || run.inputs.prompt?.name || 'Generate',
      groundTruthName: groundTruth.name || 'Ground truth', rowCount: (run.results.runResults || []).length },
  };
}

/** Every explicit Run creates an attempt; completed records are never reused as writable caches. */
export async function runEvaluation(session, state, nodeId, calculate, { signal } = {}) {
  if (!session?.projectId) throw new Error('Open a project before running Evaluate.');
  const projectId = session.projectId;
  const resolved = await resolveHistoryCanvasState(state, { index: session.index,
    loadRecord: id => session.storage.loadRecord(projectId, id) });
  const capture = await captureEvaluation(resolved.state, nodeId, {
    currentRecordIds: resolved.currentRecordIds,
    loadRecord: id => session.storage.loadRecord(projectId, id),
  });
  const at = () => session.now?.() || new Date().toISOString();
  const record = { ...capture, id: session.createId?.() || globalThis.crypto.randomUUID().replaceAll('-', ''),
    status: 'running', createdAt: at(), updatedAt: at(), results: {} };
  const persist = async value => {
    await session.storage.saveRecord(projectId, value);
    const index = await session.storage.loadIndex(projectId);
    if (session.projectId === projectId) session.index = index;
  };
  await persist(record);
  let results;
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    results = await calculate(copy(record.inputs), record);
  } catch (error) {
    await persist({ ...record, status: signal?.aborted || error.name === 'AbortError' ? 'stopped' : 'failed',
      updatedAt: at(), error: error.message || String(error) });
    throw error;
  }
  // A failed index refresh after saving completion must never downgrade the completed record.
  const finished = { ...record, status: signal?.aborted || results?.wasCancelled ? 'stopped' : 'completed', updatedAt: at(), results: copy(results) };
  await persist(finished);
  return finished;
}

/** Hydrate functions only at the boundary; their data always comes from the bound evaluation. */
export function evaluationPayload(record) {
  if (!record || record.evaluationVersion !== 1 || record.status !== 'completed') {
    throw new Error('This result has no complete evaluation snapshot. Run Evaluate to create one.');
  }
  const input = copy(record.inputs), result = copy(record.results);
  const prompt = input.prompt || {};
  const rawSchema = parsed(prompt.outputFormat, {});
  const fields = Array.isArray(rawSchema) ? rawSchema : rawSchema.fields || [];
  return {
    evaluation_record_id: record.id, evaluation_node_id: record.nodeId,
    prompt_snapshot: copy(prompt),
    prompt: prompt.text || '', run_results: input.runResults, output_fields: input.outputFields,
    output_schema: { return_shape: rawSchema.returnShape || prompt.returnShape || 'single', fields: fields.map(field => ({ ...field, allow_none: field.allowNone === true || field.allow_none === true })) },
    comparison_rows: result.comparisonRows || [], score_mapping: typeof input.mapping === 'string' ? input.mapping : JSON.stringify(input.mapping),
    score_match_code: input.activeMatchMode === 'code' ? input.matchCode : '', run_settings: input.runSettings || {},
    run_credential_id: input.runCredentialId, run_input_to_column: input.runMapping,
    runWs: input.input, gtContent: input.groundTruth.content,
    getRunWorkingSetContent: () => copy(input.input), getGroundTruthContent: () => copy(input.groundTruth.content),
  };
}

/** Compare the fixed source with the displayed Evaluate History, even when that evaluation is stale. */
export function optimizationSourceIsEarlier(node, scoreNode) {
  const displayedRecordId = scoreNode?.historyRecordId || scoreNode?.historyStaleRecordId;
  return !!node?.evaluateRecordId && node.evaluateRecordId !== displayedRecordId;
}

export function optimizationApplyBlockReason(node, scoreNode) {
  if (node?.evaluateRecordId && !scoreNode) {
    return 'Historical: its source Evaluate node is unavailable. Restore it before applying.';
  }
  if (node?.evaluateRecordId && !scoreNode?.historyRecordId && !scoreNode?.historyStaleRecordId) {
    return 'Historical: its source evaluation is not currently displayed. Select its original evaluation in History before applying.';
  }
  return optimizationSourceIsEarlier(node, scoreNode)
    ? 'Historical: this optimization uses a different Evaluate History record. Select its original evaluation in History before applying.'
    : '';
}
