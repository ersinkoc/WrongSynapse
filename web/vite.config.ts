import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// SPA config for the optional admin web UI. The Node-side backend
// (src/web/server.ts) serves the built output from web/dist/ when present;
// when absent (the default for npm-installed users), the backend returns
// 404 for non-API paths. Build artifact goes to ./dist (Vite default) and
// the repo root's .gitignore already excludes `web/dist/`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The dev server proxies /api to a running WrongSynapse instance on
    // localhost:8765 (the SSE default port). Override with SYNAPSE_DEV_API
    // when testing against a different port.
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['SYNAPSE_DEV_API'] ?? 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
