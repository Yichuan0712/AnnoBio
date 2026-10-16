/**
 * The backend's Pipeline compiler for the Current Pipeline's route, used before Export Python
 * Project. Whole-Pipeline runs are no longer started from the app (Run to here replaced them,
 * docs/design/RUN_TO_HERE_PLAN.md step 6); the backend Runner and its endpoints remain.
 */
import { BACKEND_API_BASE } from './backendConfig.js';
import { buildPipelineCompileRequest } from './pipelineRunDefinition.js';

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
