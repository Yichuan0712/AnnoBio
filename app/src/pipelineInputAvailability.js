import { datasetProducerConflicts } from './pipelineProducerConflicts.js';

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
  const producedByAnyProcess = new Set((canvasState.connections || [])
    .filter((edge) => edge?.type === 'process-to-dataset')
    .map((edge) => edge.toId));
  // A frozen copy of a selected step's output is that step's output: running the route recomputes it.
  const snapshotOfSelected = new Set((canvasState.connections || [])
    .filter((edge) => ['run-to-dataset-snapshot', 'process-to-dataset-snapshot'].includes(edge?.type)
      && (selectedRuns.has(edge.fromId) || selectedProcesses.has(edge.fromId)))
    .map((edge) => edge.toId));
  const firstJobIndex = (route || []).findIndex((item) => item?.type === 'process' || item?.type === 'prompt');
  const explicitBoundaryIds = new Set((route || [])
    .slice(0, firstJobIndex < 0 ? (route || []).length : firstJobIndex)
    .filter((item) => item?.type === 'dataset')
    .map((item) => item.dataset_node_id));
  return (route || [])
    .filter((item) => item?.type === 'dataset' && item.dataset_node_id)
    .map((item) => item.dataset_node_id)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .filter((id) => {
      const sourceRun = nodes.get(id)?.sourceRunNodeId;
      if (producedByProcess.has(id) || (sourceRun && selectedRuns.has(sourceRun))) return false;
      if ((producedByAnyProcess.has(id) || sourceRun || snapshotOfSelected.has(id)) && !explicitBoundaryIds.has(id)) return false;
      return true;
    });
}

export function assertPipelineInputsAvailable(canvasState, route) {
  const nodes = new Map((canvasState?.nodes || []).map((node) => [node?.nodeId, node]));
  const selectedIds = new Set((route || []).filter((item) => item?.type === 'dataset').map((item) => item.dataset_node_id));
  const conflicts = datasetProducerConflicts(canvasState).filter((item) => selectedIds.has(item.datasetId));
  if (conflicts.length) {
    throw new Error(`Dataset has multiple producers: ${conflicts.map((item) => nodes.get(item.datasetId)?.name || item.datasetId).join(', ')}. Remove the extra source link.`);
  }
  for (const id of pipelineInputDatasetIds(route, canvasState)) {
    const dataset = nodes.get(id);
    if (dataset?.resultMissing) {
      throw new Error(`Input Dataset "${dataset.name || id}" has no current result. Run its upstream node first.`);
    }
  }
}
