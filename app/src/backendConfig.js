export const BACKEND_HOST = '127.0.0.1';
export const BACKEND_PORT = 8000;

// Electron: the renderer's own origin (file://, or the Vite dev server) is never the local
// Python backend's origin, so it must be addressed explicitly. Web: a Hub reverse-proxies
// /api/* same-origin to this user's backend container, so a relative path is correct there
// (see vite.renderer.config.mjs's dev-server proxy for the equivalent in plain `vite dev`).
// `typeof window` guards this file also being imported by main.js in the Node main process,
// which has no `window` and doesn't need this export.
const isElectronRenderer = typeof window !== 'undefined' && !!window.electronAPI;
export const BACKEND_API_BASE = isElectronRenderer ? `http://${BACKEND_HOST}:${BACKEND_PORT}` : '';

const BACKEND_WAIT_POLL_MS = 500;

/**
 * Resolves true once the backend answers /health, false after `timeoutMs`. The desktop app opens its
 * window while the Python backend is still starting (several seconds on a cold start), so a request
 * made in that window fails with a network error rather than a real one. On the web the Hub starts
 * the user's backend on the first /api request (and only proxies /api), so there is nothing to wait for.
 */
export async function waitForBackend(timeoutMs = 30000) {
  if (!isElectronRenderer) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // A listening but unresponsive service must not leave startup waiting forever.
      const res = await fetch(`${BACKEND_API_BASE}/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now()))),
      });
      if (res.ok) return true;
    } catch (_) {
      // Not listening yet.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, BACKEND_WAIT_POLL_MS); });
  }
}
