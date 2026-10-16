import { BACKEND_API_BASE } from './backendConfig.js';
import { buildPipelineExportRequest } from './pipelineExportDefinition.js';


function downloadName(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch (_) {}
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || fallback;
}

/**
 * Ask the backend to validate and package one concrete Pipeline route.
 *
 * The payload contains live canvas configuration but no credentials beyond their opaque ids. The
 * backend writes only non-secret model metadata into the archive and never includes Dataset rows.
 */
export async function exportPythonPipeline({ name, canvasState, route }) {
  const response = await fetch(`${BACKEND_API_BASE}/api/pipeline/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPipelineExportRequest({ name, canvasState, route })),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not export this Pipeline.');
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = downloadName(response, `${name || 'pipeline'}.zip`);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
