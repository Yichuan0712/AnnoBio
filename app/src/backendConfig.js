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
