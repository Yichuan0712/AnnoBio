import { BACKEND_API_BASE } from './backendConfig.js';
import { prepareAssets } from './runClient.js';
import {
  buildPipelineCompileRequest,
  buildPipelineStartRequest,
  pipelineInputHasAssets,
} from './pipelineRunDefinition.js';

function errorMessage(data, fallback) {
  const detail = data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail?.message) {
    const messages = (detail.diagnostics || [])
      .filter((item) => item?.severity === 'error')
      .map((item) => item.message)
      .filter(Boolean);
    return messages.length ? messages.join('\n') : detail.message;
  }
  return fallback;
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${BACKEND_API_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, response.statusText || 'Pipeline request failed.'));
  return data;
}

export function compileCurrentPipeline({ canvasState, route }) {
  return jsonRequest('/api/pipeline/compile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPipelineCompileRequest({ canvasState, route })),
  });
}

/** One id per user action. Pass the same id when that action is retried, so the backend returns the
 * run it already started instead of starting a second one; a fresh id per call would defeat that. */
export function newPipelineRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `pipeline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function executionRequest({ projectId, assetProjectId, canvasState, route, requestId, path }) {
  if (!String(requestId || '').trim()) {
    throw new Error('A Pipeline start needs a requestId from newPipelineRequestId(), reused on retry.');
  }
  let projectSessionId = null;
  if (pipelineInputHasAssets(canvasState, route)) {
    const prepared = await prepareAssets(assetProjectId);
    projectSessionId = prepared?.project_session_id || null;
  }
  return jsonRequest(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPipelineStartRequest({
      projectId, projectSessionId, requestId, canvasState, route,
    })),
  });
}

export function startCurrentPipeline(options) {
  return executionRequest({ ...options, path: '/api/pipeline/runs' });
}

export function reviseCurrentPipeline(runId, options) {
  return executionRequest({
    ...options,
    path: `/api/pipeline/runs/${encodeURIComponent(runId)}/revisions`,
  });
}

export function getPipelineRun(projectId, runId) {
  return jsonRequest(`/api/pipeline/runs/${encodeURIComponent(runId)}?project_id=${encodeURIComponent(projectId)}`);
}

export function listPipelineRuns(projectId) {
  return jsonRequest(`/api/pipeline/runs?project_id=${encodeURIComponent(projectId)}`);
}

export function getPipelineRunDefinition(projectId, runId) {
  return jsonRequest(`/api/pipeline/runs/${encodeURIComponent(runId)}/definition?project_id=${encodeURIComponent(projectId)}`);
}

export function cancelPipelineRun(projectId, runId) {
  return jsonRequest(`/api/pipeline/runs/${encodeURIComponent(runId)}/cancel?project_id=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  });
}

/** Removes a finished run and its stored tables; results already on the canvas keep their own copies. */
export function deletePipelineRun(projectId, runId) {
  return jsonRequest(`/api/pipeline/runs/${encodeURIComponent(runId)}?project_id=${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
}

export async function resumePipelineRun(projectId, runId, assetProjectId = null, needsAssets = false) {
  let projectSessionId = null;
  if (needsAssets) {
    const prepared = await prepareAssets(assetProjectId);
    projectSessionId = prepared?.project_session_id || null;
  }
  return jsonRequest(`/api/pipeline/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, ...(projectSessionId ? { project_session_id: projectSessionId } : {}) }),
  });
}

export function getPipelineResults(projectId, runId, logicalId = null) {
  const query = new URLSearchParams({ project_id: projectId });
  if (logicalId) query.set('logical_id', logicalId);
  return jsonRequest(`/api/pipeline/runs/${encodeURIComponent(runId)}/results?${query}`);
}
