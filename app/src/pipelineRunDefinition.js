import { isAssetCell } from './datasetContent.js';
import { exportCanvasDefinition } from './pipelineExportDefinition.js';
import { pipelineInputDatasetIds } from './pipelineInputAvailability.js';
export { pipelineInputDatasetIds } from './pipelineInputAvailability.js';

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
