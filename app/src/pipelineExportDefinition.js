import { assertPipelineInputsAvailable } from './pipelineInputAvailability.js';

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
          sourceRunNodeId: node.sourceRunNodeId,
          processOutputName: node.processOutputName,
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
          primaryDatasetId: node.primaryDatasetId,
          datasetAliases: node.datasetAliases,
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
          runWorkingSetId: node.runWorkingSetId,
          runCredentialId: node.runCredentialId,
          runInputToColumn: node.runInputToColumn,
          runSettings: node.runSettings,
        };
      }
      return null;
    })
    .filter(Boolean);
  const executableEdgeTypes = new Set([
    'dataset-to-process',
    'process-to-dataset',
    'prompt-to-run',
    'prompt-to-prompt',
  ]);
  const connections = (canvasState?.connections || []).filter((edge) => (
    executableEdgeTypes.has(edge?.type) && (
      ids.has(edge?.toId) || (edge?.type === 'process-to-dataset' && ids.has(edge?.fromId))
    )
  ));
  return { version: canvasState?.version || 2, nodes, connections };
}

/** The first displayed Dataset explicitly supplies the starting data snapshot. */
export function buildPipelineExportRequest({ name, canvasState, route }) {
  assertPipelineInputsAvailable(canvasState, route);
  const first = route?.[0];
  return {
    name,
    canvas_state: exportCanvasDefinition(canvasState, route),
    route,
    input_dataset_ids: first?.type === 'dataset' ? [first.dataset_node_id] : [],
  };
}
