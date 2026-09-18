import { BACKEND_API_BASE } from './backendConfig.js';

// Registers this project's images with the backend so image_ref parts in a run/review request
// can be resolved to actual image bytes. Desktop: Electron's own ProjectAssets instance already
// knows which project is open, so projectId is ignored. Web: callers pass getCurrentProjectId()
// (see currentProject.js) since these run/review helpers otherwise have no path back to
// renderer.js's local state.
async function prepareAssets(projectId) {
  if (window.electronAPI) return window.electronAPI.prepareAssets();
  if (!projectId) throw new Error('Image-bearing runs need an open project on the web build.');
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/assets/prepare`, { method: 'POST' });
  if (!res.ok) throw new Error('Could not prepare images for this run.');
  return res.json();
}

export async function postRun(body, signal, apiBase = BACKEND_API_BASE, projectId = null) {
  const hasImages = body.samples?.some((sample) => sample.content?.some((part) => part.type === 'image_ref'));
  const session = hasImages ? await prepareAssets(projectId) : {};
  return fetch(`${apiBase}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ...body, ...session }),
  });
}

export async function prepareReviewBody(body, projectId = null) {
  const session = await prepareAssets(projectId).catch(() => null);
  return { ...body, ...(session || {}) };
}
