/**
 * Agent access to the Pipeline's selected route: Export Python Project, as on its card.
 * Running is not a pipeline_action any more: run_nodes run_to runs a step and the steps before it,
 * like the user's Run to here (docs/design/RUN_TO_HERE_PLAN.md step 6).
 */
import { exportRoutePayload } from '../../pipelineRouteSelection.js';
import { exportPythonPipeline } from '../../pipelineExportClient.js';
import { pipelineRouteKey } from '../../pipelineRunDefinition.js';
import { compileCurrentPipeline } from '../../pipelineRunClient.js';

function selection(runtime, pipelineId) {
  const item = runtime.getPipelineSelections?.().find((entry) => entry.id === String(pipelineId || ''));
  if (!item) throw new Error('That Pipeline is no longer on the canvas. Call get_workspace for its current id.');
  return item;
}

function routeOf(item) {
  return exportRoutePayload(item.route);
}

function routeNodeIds(route) {
  return new Set(route.map((step) => step.run_node_id || step.process_node_id).filter(Boolean));
}

function exportName(item, runtime, given) {
  if (String(given || '').trim()) return String(given).trim();
  const nodes = new Map(runtime.getCanvasState().nodes.map((node) => [node.nodeId, node]));
  const route = routeOf(item);
  const first = route.find((step) => step.prompt_node_id || step.process_node_id);
  const name = nodes.get(first?.prompt_node_id || first?.process_node_id)?.name;
  return name ? `${name} pipeline` : `pipeline-${item.index + 1}`;
}

export async function previewPipelineAction(args, runtime) {
  try {
    const action = String(args?.action || '');
    if (action !== 'export') {
      throw new Error('action must be export. To run steps, use run_nodes with a run_to job on the last step to run.');
    }
    const item = selection(runtime, args.pipeline_id);
    const route = routeOf(item);
    if (!routeNodeIds(route).size) throw new Error('The selected route has no runnable steps.');
    const compiled = await compileCurrentPipeline({ canvasState: runtime.getCanvasState(), route });
    const errors = (compiled.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error');
    if (!compiled.spec || errors.length) throw new Error(errors.map((error) => error.message).join('; ') || 'This route cannot be compiled.');
    return {
      ok: true,
      items: [{ kind: 'update', title: `Export Pipeline ${item.index + 1}`, nodeIds: [...routeNodeIds(route)], lines: [
        `Route: ${route.filter((step) => step.type !== 'dataset').length} executable steps.`,
        `Selection: ${item.source === 'panel' ? 'Pipeline panel' : 'default route (panel is not mounted)'}.`,
        'A Python project zip will be downloaded. Dataset rows and files are excluded.',
      ] }],
      action, routeKey: pipelineRouteKey(route), runId: '', projectId: '',
      projectIdentity: runtime.getAssetProjectId?.() ?? null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executePipelineAction(args, preview, runtime) {
  if (args.action !== 'export') throw new Error('Only export is available; prepare the action again.');
  const item = selection(runtime, args.pipeline_id);
  const route = routeOf(item);
  if (pipelineRouteKey(route) !== preview.routeKey) throw new Error('The selected route changed. Ask the Agent to prepare this action again.');
  if ((runtime.getAssetProjectId?.() ?? null) !== (preview.projectIdentity ?? null)) {
    throw new Error('The open project changed. Prepare this action again.');
  }
  await exportPythonPipeline({ name: exportName(item, runtime, args.name), canvasState: runtime.getCanvasState(), route });
  return { status: 'exported', pipeline_id: item.id };
}
