import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, strictPort: true, hmr: { overlay: false } },
  worker: { format: 'es' },
  // Serve three as plain ESM (no pre-bundling) so new addon imports never
  // trigger mid-session dependency re-optimization reloads.
  optimizeDeps: { exclude: ['three'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
});
