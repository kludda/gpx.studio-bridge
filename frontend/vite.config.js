import { defineConfig } from 'vite';

// The bridge shell. Frames the real editor at VITE_EDITOR_URL (…/app?embedded=1).
export default defineConfig({
  root: __dirname,
  publicDir: false,
  server: {
    port: 5174,
    strictPort: true,
    // [embed] Allow the reverse-proxied host (gpx.eel.se) through Vite's host check.
    // Leading dot = the domain and all its subdomains.
    allowedHosts: ['.eel.se'],
    // [embed] Proxy the FastAPI backend through this dev server so the shell calls it
    // same-origin via VITE_API_BASE=/api — keeps it out of the external proxy, and the
    // browser never needs to reach :3001 directly (the hop is server-side here).
    // The /api prefix is stripped, so run uvicorn with ROOT_PATH=/api (docs at /api/docs).
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
