import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig(({ command }) => ({
  // The Hub (hub/main.py) serves this build's output under /app (root "/" is its own public
  // landing page), so built asset URLs need that prefix. `vite dev` still serves at root, since
  // it has no landing page of its own to conflict with.
  base: command === 'build' ? '/app/' : '/',
  server: {
    // Lets `vite dev` alone (no Electron, no Hub) exercise the web build against a directly
    // running `uvicorn main:app --port 8000` backend, matching backendConfig.js's relative
    // BACKEND_API_BASE for non-Electron origins.
    proxy: {
      '/api': 'http://127.0.0.1:8020',
    },
  },
}));
