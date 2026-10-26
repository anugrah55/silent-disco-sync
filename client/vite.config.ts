import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.SDS_SERVER ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
