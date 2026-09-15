import { BACKEND_API_BASE } from './backendConfig.js';

export async function postRun(body, signal, apiBase = BACKEND_API_BASE) {
  const hasImages = body.samples?.some((sample) => sample.content?.some((part) => part.type === 'image_ref'));
  const session = hasImages ? await window.electronAPI.prepareAssets() : {};
  return fetch(`${apiBase}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ...body, ...session }),
  });
}

export async function prepareReviewBody(body) {
  const session = await window.electronAPI?.prepareAssets?.();
  return { ...body, ...(session || {}) };
}
