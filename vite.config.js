import { defineConfig } from 'vite';

/**
 * Vite config.
 *
 * **`base`**: when building for GitHub Pages the site is served at
 * `https://<user>.github.io/Luminoir/`, so every absolute asset
 * URL (script tags, score-fetch URLs, etc.) needs the `/Luminoir/`
 * prefix.  Locally the dev server serves at `/`, so we toggle on
 * `process.env.GITHUB_ACTIONS` (set in the deploy workflow) to keep
 * the dev experience untouched.
 *
 * **COOP / COEP headers**: WebAssembly threads (used by Verovio's
 * threaded WASM build) require a cross-origin-isolated context.
 * Set the headers in dev so threading actually works against
 * `localhost:5173`; in production the same headers are enforced via
 * `_headers` if the host supports it (GitHub Pages does not, but
 * Verovio falls back to the single-threaded WASM build there).
 */
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/Luminoir/' : '/',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['verovio'],
  },
  server: {
    // `true` binds to 0.0.0.0 so the dev server is reachable from other
    // machines on the LAN (Vite prints the Network URL on startup).
    host: true,
    port: 5173,
    strictPort: true,
    // Vite 5+ blocks requests from unknown Hosts by default; allow any so
    // mDNS hostnames (e.g. `macbook-pro.local`) and other LAN devices work.
    allowedHosts: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
