import { assertPipelineInputsAvailable, pipelineInputDatasetIds } from './pipelineInputAvailability.js';
import { stepSourceLabel } from './stepInputs.js';

function selectedNodeIds(route) {
  const ids = new Set();
  for (const item of route || []) {
    for (const key of ['dataset_node_id', 'process_node_id', 'prompt_node_id', 'run_node_id']) {
      if (item?.[key]) ids.add(item[key]);
    }
  }
  return ids;
}

/** Keep the export request code-only: Dataset rows, cached results and review state never leave the renderer. */
export function exportCanvasDefinition(canvasState, route) {
  const ids = selectedNodeIds(route);
  const nodes = (canvasState?.nodes || [])
    .filter((node) => ids.has(node?.nodeId))
    .map((node) => {
      if (node.type === 'dataset') {
        return {
          type: 'dataset',
          nodeId: node.nodeId,
          name: node.name,
          resultMissing: !!node.resultMissing,
          datasetContent: {
            headers: node.datasetContent?.headers || [],
            columnTypes: node.datasetContent?.columnTypes || [],
            row_count: node.datasetContent?.rows?.length || 0,
          },
        };
      }
      if (node.type === 'process') {
        return {
          type: 'process',
          nodeId: node.nodeId,
          name: node.name,
          code: node.code,
          dfCode: node.dfCode,
          activeMode: node.activeMode,
        };
      }
      if (node.type === 'prompt') {
        return {
          type: 'prompt',
          nodeId: node.nodeId,
          name: node.name,
          note: node.note,
          sections: node.sections,
          outputFormat: node.outputFormat,
          inputTypes: node.inputTypes,
        };
      }
      if (node.type === 'run') {
        return {
          type: 'run',
          nodeId: node.nodeId,
          runName: node.runName,
          runCredentialId: node.runCredentialId,
          runInputToColumn: node.runInputToColumn,
          runSettings: node.runSettings,
        };
      }
      return null;
    })
    .filter(Boolean);
  // What the selected steps read (`data`), and which Prompt each Run uses. Saved-from links are not
  // sent: a Dataset is only an input (docs/design/DATA_FLOW_DESIGN.md §6.1).
  const executableEdgeTypes = new Set(['data', 'prompt-to-run', 'prompt-to-prompt']);
  const connections = (canvasState?.connections || []).filter((edge) => executableEdgeTypes.has(edge?.type) && ids.has(edge?.toId));
  // A step read from outside the route goes as its name only, so the compiler can say which it is.
  const byId = new Map((canvasState?.nodes || []).map((node) => [node?.nodeId, node]));
  for (const edge of connections) {
    const upstream = byId.get(edge.fromId);
    if (edge.type !== 'data' || ids.has(edge.fromId) || !['run', 'process'].includes(upstream?.type)) continue;
    if (nodes.some((node) => node.nodeId === edge.fromId)) continue;
    nodes.push({ type: upstream.type, nodeId: upstream.nodeId, name: stepSourceLabel(canvasState, { nodeId: upstream.nodeId, port: 'result' }) });
  }
  return { version: canvasState?.version || 3, nodes, connections };
}

/** Every external Dataset in the selected route is an explicit input boundary. */
export function buildPipelineExportRequest({ name, canvasState, route }) {
  assertPipelineInputsAvailable(canvasState, route);
  return {
    name,
    canvas_state: exportCanvasDefinition(canvasState, route),
    route,
    input_dataset_ids: pipelineInputDatasetIds(route, canvasState),
  };
}
