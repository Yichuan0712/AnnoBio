/** Datasets read as external inputs by the selected route, rather than produced by its jobs. */
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

export function assertPipelineInputsAvailable(canvasState, route) {
  const nodes = new Map((canvasState?.nodes || []).map((node) => [node?.nodeId, node]));
  for (const id of pipelineInputDatasetIds(route, canvasState)) {
    const dataset = nodes.get(id);
    if (dataset?.resultMissing) {
      throw new Error(`Input Dataset "${dataset.name || id}" has no current result. Run its upstream node first.`);
    }
  }
}
