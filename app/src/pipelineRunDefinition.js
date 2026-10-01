import { isAssetCell } from './datasetContent.js';
import { exportCanvasDefinition } from './pipelineExportDefinition.js';

export function pipelineInputDatasetIds(route, canvasState = null) {
  if (!canvasState) {
    const first = route?.[0];
    return first?.type === 'dataset' && first.dataset_node_id ? [first.dataset_node_id] : [];
  }
  const selectedRuns = new Set((route || []).map((item) => item?.run_node_id).filter(Boolean));
  const selectedProcesses = new Set((route || []).map((item) => item?.process_node_id).filter(Boolean));
  const nodes = new Map((canvasState.nodes || []).map((node) => [node?.nodeId, node]));
  const producedByProcess = new Set((canvasState.connections || [])
    .filter((edge) => edge?.type === 'process-to-dataset' && selectedProcesses.has(edge.fromId))
    .map((edge) => edge.toId));
  return (route || [])
    .filter((item) => item?.type === 'dataset' && item.dataset_node_id)
    .map((item) => item.dataset_node_id)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .filter((id) => {
      const sourceRun = nodes.get(id)?.sourceRunNodeId;
      return !producedByProcess.has(id) && !(sourceRun && selectedRuns.has(sourceRun));
    });
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** Compile/start payload: selected executable definition plus rows only for explicit inputs. */
export function pipelineRunCanvasDefinition(canvasState, route) {
  const definition = exportCanvasDefinition(canvasState, route);
  const inputIds = new Set(pipelineInputDatasetIds(route, canvasState));
  const sourceById = new Map((canvasState?.nodes || []).map((node) => [node?.nodeId, node]));
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type !== 'dataset' || !inputIds.has(node.nodeId)) return node;
      const content = sourceById.get(node.nodeId)?.datasetContent || {};
      return {
        ...node,
        datasetContent: {
          headers: cloneJson(content.headers || []),
          columnTypes: cloneJson(content.columnTypes || []),
          rowIds: cloneJson(content.rowIds || []),
          rows: cloneJson(content.rows || []),
          row_count: content.rows?.length || 0,
        },
      };
    }),
  };
}

export function buildPipelineCompileRequest({ canvasState, route }) {
  return {
    canvas_state: pipelineRunCanvasDefinition(canvasState, route),
    route,
    input_dataset_ids: pipelineInputDatasetIds(route, canvasState),
  };
}

export function buildPipelineStartRequest({ projectId, projectSessionId, requestId, canvasState, route }) {
  return {
    project_id: projectId,
    ...buildPipelineCompileRequest({ canvasState, route }),
    ...(projectSessionId ? { project_session_id: projectSessionId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

export function pipelineInputHasAssets(canvasState, route) {
  const ids = new Set(pipelineInputDatasetIds(route, canvasState));
  return (canvasState?.nodes || []).some((node) => (
    node?.type === 'dataset' && ids.has(node.nodeId)
    && (node.datasetContent?.rows || []).some((row) => Array.isArray(row) && row.some((cell) => isAssetCell(cell)))
  ));
}

export function pipelineRouteKey(route) {
  return JSON.stringify((route || []).map((item) => [
    item?.type || '', item?.dataset_node_id || '', item?.process_node_id || '',
    item?.prompt_node_id || '', item?.run_node_id || '',
  ]));
}

/** Human-facing preflight estimate. Unknown is intentional after Process or table expansion. */
export function buildPipelineValidationPreview(result, canvasState, modelContext = {}) {
  if (!result?.spec) return null;
  const nodes = new Map((canvasState?.nodes || []).map((node) => [node.nodeId, node]));
  const credentials = new Map((modelContext.credentials || []).map((item) => [item.id, item]));
  const artifacts = new Map((result.spec.artifacts || []).map((item) => [item.id, item]));
  const knownRows = new Map();
  for (const logicalId of result.spec.inputs || []) {
    const nodeId = logicalId.replace(/^dataset:/, '');
    knownRows.set(logicalId, nodes.get(nodeId)?.datasetContent?.rows?.length ?? 0);
  }
  const jobs = (result.spec.jobs || []).map((job) => {
    const inputIds = Object.values(job.inputs || {});
    const rows = inputIds.length === 1 ? knownRows.get(inputIds[0]) : undefined;
    let model = '';
    if (job.type === 'llm') {
      const runId = job.config?.model_binding?.run_node_id;
      const credentialId = nodes.get(runId)?.runCredentialId || modelContext.settings?.default_run_credential_id || '';
      const credential = credentials.get(credentialId);
      model = credential?.model || credential?.llm || 'model missing';
    }
    const source = result.spec.source_map?.[job.id];
    const outputRows = job.type === 'llm' && job.config?.output_schema?.return_shape === 'single' ? rows : undefined;
    for (const ids of Object.values(job.outputs || {})) {
      for (const logicalId of ids) {
        if (outputRows == null) knownRows.delete(logicalId); else knownRows.set(logicalId, outputRows);
      }
    }
    return { type: job.type, name: source?.names?.[0] || job.id, model, calls: job.type === 'llm' ? rows : null };
  });
  const inputs = (result.spec.inputs || []).map((logicalId) => {
    const artifact = artifacts.get(logicalId);
    return `${artifact?.name || logicalId} (${knownRows.get(logicalId) ?? 0} rows)`;
  });
  return { inputLabel: inputs.join(', ') || 'none', jobs };
}
