import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildVersion } from '../scripts/version.mjs';

export default defineConfig(({ mode }) => ({
  // Production build is served under /manage/ on Pages; dev server uses root.
  base: mode === 'production' ? '/manage/' : '/',
  plugins: [react(), tailwindcss()],
  // Stamped into the SPA so the "how to embed" snippet can carry widget.js?v=<version>.
  define: { __FF_VERSION__: JSON.stringify(buildVersion()) },
  build: {
    outDir: '../dist/manage',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, the SPA talks to `wrangler pages dev` running the Functions + D1.
      '/api': 'http://localhost:8788',
    },
  },
}));
