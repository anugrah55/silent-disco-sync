import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.SDS_SERVER ?? 'http://localhost:3000';
// Identifies this client build. The server reads build-id.txt from the same
// dist folder and reports it on join, so a tab opened before a deploy can tell.
const BUILD_ID = (process.env.RENDER_GIT_COMMIT ?? '').slice(0, 12) || Date.now().toString(36);

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'sds-build-id',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: BUILD_ID });
      },
    },
  ],
  server: {
    // Listen on the LAN so phones can open the dev build.
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: API },
      // changeOrigin stays false so Host still matches Origin for the server's origin check.
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
