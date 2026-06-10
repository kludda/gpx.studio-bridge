import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The bridge shell. Serves the repo's dev/ mocks (fake-editor.html, fake-host.html)
// at the site root via publicDir, so the iframe can load them same-origin during
// M1–M4. Flip VITE_EDITOR_URL to the real editor (…/app?embed=1) for M8.
export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, '../dev'),
  server: {
    port: 5174,
    strictPort: true,
  },
});
