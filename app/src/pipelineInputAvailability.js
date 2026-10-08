import { processInputSources, runInputSource } from './stepInputs.js';

/**
 * The Datasets the selected route starts from: every Dataset a selected Run or Process reads
 * (docs/design/DATA_FLOW_DESIGN.md §6.3). Steps pass their outputs to each other directly, so every
 * Dataset is an input. In route order.
 */
export function pipelineInputDatasetIds(route, canvasState = null) {
  if (!canvasState) {
    const first = route?.[0];
    return first?.type === 'dataset' && first.dataset_node_id ? [first.dataset_node_id] : [];
  }
  const nodes = new Map((canvasState.nodes || []).map((node) => [node?.nodeId, node]));
  const ids = [];
  const add = (source) => {
    if (source?.kind === 'dataset' && nodes.get(source.nodeId)?.type === 'dataset' && !ids.includes(source.nodeId)) ids.push(source.nodeId);
  };
  for (const item of route || []) {
    if (item?.type === 'prompt') add(runInputSource(canvasState, item.run_node_id));
    if (item?.type === 'process') processInputSources(canvasState, item.process_node_id).forEach(add);
  }
  return ids;
}

export function assertPipelineInputsAvailable(canvasState, route) {
  const nodes = new Map((canvasState?.nodes || []).map((node) => [node?.nodeId, node]));
  for (const id of pipelineInputDatasetIds(route, canvasState)) {
    const dataset = nodes.get(id);
    if (dataset?.resultMissing) {
      throw new Error(`Input Dataset "${dataset.name || id}" has no current result. Run its upstream node first.`);
    }
  }
}
