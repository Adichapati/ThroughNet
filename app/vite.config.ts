import { defineConfig } from 'vite';

// ThroughNet app (ADR-151, server-as-shell). The Rust sensing-server will
// embed this build (rust-embed) and serve it alongside the localhost setup +
// /ws/sensing endpoints. Dev runs standalone against mock state.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
