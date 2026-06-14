import { defineConfig } from 'vite';

// ThroughNet app (ADR-151, server-as-shell). The Rust sensing-server will
// embed this build (rust-embed) and serve it alongside the localhost setup +
// /ws/sensing endpoints. Dev runs standalone against mock state.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    // dev: reach the sensing-server (same-origin in production via rust-embed).
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
