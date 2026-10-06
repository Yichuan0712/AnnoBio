/** Agent access to the same selected route and Pipeline run APIs used by Current Pipeline. */
import { exportRoutePayload } from '../../pipelineRouteSelection.js';
import { exportPythonPipeline } from '../../pipelineExportClient.js';
import { pipelineInputSteps } from '../../pipelineRunInputs.js';
import { pipelineRouteKey, pipelineInputHasAssets } from '../../pipelineRunDefinition.js';
import {
  cancelPipelineRun, compileCurrentPipeline, getPipelineRun, listPipelineRuns,
  newPipelineRequestId, resumePipelineRun, startCurrentPipeline,
} from '../../pipelineRunClient.js';

const ACTIVE = new Set(['pending', 'running']);
const RESUMABLE = new Set(['failed', 'cancelled', 'interrupted']);

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

function belongsToPipeline(run, item) {
  const ids = new Set(item.nodeIds?.length ? item.nodeIds : [...routeNodeIds(routeOf(item))]);
  const jobIds = run.job_ids || (run.jobs || []).map((job) => job.job_id);
  return jobIds.some((jobId) => ids.has(String(jobId).replace(/^(llm|process):/, '')));
}

function summarizeRun(run, detailed = false) {
  return {
    run_id: run.run_id,
    status: run.status,
    created_at: run.created_at,
    finished_at: run.finished_at,
    job_ids: run.job_ids || (run.jobs || []).map((job) => job.job_id),
    produced_artifact_ids: run.produced_artifact_ids || (run.artifacts || [])
      .filter((artifact) => artifact.valid && artifact.producer).map((artifact) => artifact.logical_id),
    error: run.error || undefined,
    ...(detailed ? { jobs: (run.jobs || []).map((job) => ({
      job_id: job.job_id, status: job.status, completed: job.completed, total: job.total,
      error: job.error || undefined,
    })), plan: run.plan || undefined } : {}),
  };
}

export async function readPipelineRuns(args, runtime) {
  const projectId = await runtime.getPipelineProjectId();
  if (args.run_id) {
    const run = await getPipelineRun(projectId, String(args.run_id));
    if (args.pipeline_id && !belongsToPipeline(run, selection(runtime, args.pipeline_id))) {
      throw new Error('That run does not belong to the requested Pipeline.');
    }
    return summarizeRun(run, true);
  }
  const runs = await listPipelineRuns(projectId);
  const item = args.pipeline_id ? selection(runtime, args.pipeline_id) : null;
  const matching = item ? runs.filter((run) => belongsToPipeline(run, item)) : runs;
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
  return { total: matching.length, runs: matching.slice(0, limit).map(summarizeRun) };
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
    if (!['run', 'export', 'stop', 'resume'].includes(action)) throw new Error('action must be run, export, stop or resume.');
    const item = selection(runtime, args.pipeline_id);
    const route = routeOf(item);
    const projectId = action === 'export' ? '' : await runtime.getPipelineProjectId();
    if (!routeNodeIds(route).size) throw new Error('The selected route has no runnable steps.');
    const state = runtime.getCanvasState();
    const lines = [`Route: ${route.filter((step) => step.type !== 'dataset').length} executable steps.`,
      `Selection: ${item.source === 'panel' ? 'Current Pipeline panel' : 'default route (panel is not mounted)'}.`];
    let runId = '';
    if (action === 'run' || action === 'export') {
      const compiled = await compileCurrentPipeline({ canvasState: state, route });
      const errors = (compiled.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error');
      if (!compiled.spec || errors.length) throw new Error(errors.map((item) => item.message).join('; ') || 'This route cannot be compiled.');
      if (action === 'run') {
        for (const step of pipelineInputSteps(state, route)) {
          lines.push(`${step.kind === 'run' ? 'Run' : 'Process'} ${step.name} reads ${step.inputs.map((input) => input.name).join(', ')}.`);
        }
        lines.push('Model cost cannot be estimated for the whole Pipeline in advance.');
      } else lines.push('A Python project zip will be downloaded. Dataset rows and files are excluded.');
    } else {
      runId = String(args.run_id || '').trim();
      if (!runId) throw new Error(`${action} needs run_id from get_pipeline_runs.`);
      const run = await getPipelineRun(projectId, runId);
      if (!belongsToPipeline(run, item)) throw new Error('That run does not belong to this Pipeline.');
      if (action === 'stop' && !ACTIVE.has(run.status)) throw new Error(`Run ${runId} is ${run.status}, so it cannot be stopped.`);
      if (action === 'resume' && !RESUMABLE.has(run.status)) throw new Error(`Run ${runId} is ${run.status}, so it cannot be resumed.`);
      lines.push(`Run ${runId}: ${run.status}.`);
    }
    return {
      ok: true,
      items: [{ kind: action === 'stop' ? 'remove' : 'update', title: `${action[0].toUpperCase()}${action.slice(1)} Pipeline ${item.index + 1}`, lines,
        nodeIds: [...routeNodeIds(route)] }],
      action, routeKey: pipelineRouteKey(route), runId, projectId,
      projectIdentity: runtime.getAssetProjectId?.() ?? null,
      requestId: action === 'run' ? newPipelineRequestId() : undefined,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executePipelineAction(args, preview, runtime) {
  const item = selection(runtime, args.pipeline_id);
  const route = routeOf(item);
  if (pipelineRouteKey(route) !== preview.routeKey) throw new Error('The selected route changed. Ask the Agent to prepare this action again.');
  if ((runtime.getAssetProjectId?.() ?? null) !== (preview.projectIdentity ?? null)) {
    throw new Error('The open project changed. Prepare this action again.');
  }
  const projectId = args.action === 'export' ? '' : await runtime.getPipelineProjectId();
  if (args.action !== 'export' && projectId !== preview.projectId) throw new Error('The open project changed. Prepare this action again.');
  if (args.action === 'run') {
    const state = runtime.getCanvasState();
    const compiled = await compileCurrentPipeline({ canvasState: state, route });
    if (!compiled.spec) throw new Error('The Pipeline configuration changed and can no longer run.');
    const run = await startCurrentPipeline({
      projectId, assetProjectId: runtime.getAssetProjectId?.(), canvasState: state, route,
      requestId: preview.requestId,
    });
    let warning;
    try { await runtime.registerPipelineRun(item.id, run, pipelineInputHasAssets(state, route)); }
    catch (error) { warning = `The run started, but the panel could not attach it: ${error.message}`; }
    return { status: 'started', run: summarizeRun(run), ...(warning ? { warning } : {}) };
  }
  if (args.action === 'export') {
    await exportPythonPipeline({ name: exportName(item, runtime, args.name), canvasState: runtime.getCanvasState(), route });
    return { status: 'exported', pipeline_id: item.id };
  }
  const runId = String(args.run_id || '').trim();
  if (!runId || runId !== preview.runId) throw new Error('The run id changed. Prepare this action again.');
  const current = await getPipelineRun(projectId, runId);
  if (!belongsToPipeline(current, item)) throw new Error('The run no longer belongs to this Pipeline.');
  if (args.action === 'stop') {
    if (!ACTIVE.has(current.status)) throw new Error(`Run ${runId} is already ${current.status}.`);
    const run = await cancelPipelineRun(projectId, runId);
    let warning;
    try { await runtime.registerPipelineRun(item.id, run); }
    catch (error) { warning = `The stop request was sent, but the panel could not update: ${error.message}`; }
    return { status: 'stopping', run: summarizeRun(run), ...(warning ? { warning } : {}) };
  }
  if (!RESUMABLE.has(current.status)) throw new Error(`Run ${runId} cannot be resumed from ${current.status}.`);
  const needsAssets = runtime.getPipelineRunNeedsAssets?.(runId)
    ?? pipelineInputHasAssets(runtime.getCanvasState(), route);
  const run = await resumePipelineRun(projectId, runId, runtime.getAssetProjectId?.(), needsAssets);
  let warning;
  try { await runtime.registerPipelineRun(item.id, run, needsAssets); }
  catch (error) { warning = `The run resumed, but the panel could not update: ${error.message}`; }
  return { status: 'resumed', run: summarizeRun(run), ...(warning ? { warning } : {}) };
}
