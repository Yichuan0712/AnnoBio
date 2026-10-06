import { assertPipelineInputsAvailable, pipelineInputDatasetIds } from './pipelineInputAvailability.js';

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
          savedCopy: !!node.savedCopy,
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
  // A Process's other outputs stay visible so the compiler can ask for branch names, except further
  // saved versions of a branch the route already carries (an unnamed output is the `result` branch).
  const branchOf = new Map((canvasState?.nodes || []).map((node) => [
    node?.nodeId, String(node?.processOutputName || '').trim() || 'result',
  ]));
  const routeBranches = new Set((canvasState?.connections || [])
    .filter((edge) => edge?.type === 'process-to-dataset' && ids.has(edge.fromId) && ids.has(edge.toId))
    .map((edge) => `${edge.fromId}\u0000${branchOf.get(edge.toId) || 'result'}`));
  // A frozen copy of a selected step's output in the route is that step's output when it runs
  // (pipelineInputAvailability.js); the compiler needs the copy's origin to chain it.
  const snapshotEdgeTypes = new Set(['run-to-dataset-snapshot', 'process-to-dataset-snapshot']);
  const connections = (canvasState?.connections || []).filter((edge) => (
    (executableEdgeTypes.has(edge?.type) && (
      ids.has(edge?.toId) || (edge?.type === 'process-to-dataset' && ids.has(edge?.fromId)
        && !routeBranches.has(`${edge.fromId}\u0000${branchOf.get(edge.toId) || 'result'}`))
    )) || (snapshotEdgeTypes.has(edge?.type) && ids.has(edge.fromId) && ids.has(edge.toId))
  ));
  return { version: canvasState?.version || 2, nodes, connections };
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
