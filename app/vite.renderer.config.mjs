import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  server: {
    // Lets `vite dev` alone (no Electron, no Hub) exercise the web build against a directly
    // running `uvicorn main:app --port 8000` backend, matching backendConfig.js's relative
    // BACKEND_API_BASE for non-Electron origins.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
});
