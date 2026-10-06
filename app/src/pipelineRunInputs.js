/**
 * The steps of a Pipeline route that read a Dataset from outside it. Run Pipeline lists them, so the
 * user can open each one and set what it reads before the run starts. Pure: canvas state and route
 * payload in.
 */
import { pipelineInputDatasetIds } from './pipelineInputAvailability.js';

/**
 * @returns {Array<{ nodeId: string, kind: 'run'|'process', name: string,
 *   inputs: Array<{ nodeId: string, name: string, colorIndex: number|undefined }> }>}
 *   in route order; a Run is named after its Prompt, as the Current Pipeline names it
 */
export function pipelineInputSteps(canvasState, route) {
  const nodes = new Map((canvasState?.nodes || []).map((node) => [node.nodeId, node]));
  const connections = canvasState?.connections || [];
  const inputIds = new Set(pipelineInputDatasetIds(route, canvasState));
  const dataset = (nodeId) => ({ nodeId, name: nodes.get(nodeId)?.name || 'Dataset', colorIndex: nodes.get(nodeId)?.colorIndex });
  const steps = [];
  for (const item of route || []) {
    if (item?.type === 'prompt') {
      const inputId = nodes.get(item.run_node_id)?.runWorkingSetId;
      if (!inputIds.has(inputId)) continue;
      steps.push({ nodeId: item.run_node_id, kind: 'run', name: nodes.get(item.prompt_node_id)?.name || 'Prompt', inputs: [dataset(inputId)] });
    } else if (item?.type === 'process') {
      const read = connections
        .filter((edge) => edge.type === 'dataset-to-process' && edge.toId === item.process_node_id && inputIds.has(edge.fromId))
        .map((edge) => dataset(edge.fromId));
      if (read.length) steps.push({ nodeId: item.process_node_id, kind: 'process', name: nodes.get(item.process_node_id)?.name || 'Process', inputs: read });
    }
  }
  return steps;
}
