import { defineConfig } from 'vite';

// The bridge shell. Frames the real editor at VITE_EDITOR_URL (…/app?embedded=1).
export default defineConfig({
  root: __dirname,
  publicDir: false,
  server: {
    port: 5174,
    strictPort: true,
    // [embed] Accept any Host header. Vite's host check guards against DNS-rebinding
    // attacks on the dev server; `true` disables it so the shell works behind any
    // reverse-proxied hostname with no per-domain edits. Fine for this LAN-bound POC —
    // if you expose it beyond a trusted LAN, replace with an allowlist of your real
    // hostnames, e.g. ['.example.com'] (leading dot = domain + all subdomains).
    allowedHosts: true,
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
