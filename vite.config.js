import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

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
 *
 * **LAN HTTPS (opt-in)**: Chrome's Private Network Access (PNA) policy
 * requires a PNA preflight OPTIONS request before loading ES-module
 * workers from a LAN origin over plain HTTP.  Chrome gives the server
 * only 200 ms to respond — if the dev server is slow to reply (cold
 * start, busy CPU) the preflight times out and the score worker fires
 * `onerror`, producing "score worker crashed".  The `Access-Control-
 * Allow-Private-Network: true` response header is correct but doesn't
 * eliminate the race.
 *
 * Running the dev server over HTTPS removes the PNA preflight entirely
 * (PNA only applies to HTTP→private-network).  Use:
 *
 *   pnpm dev:lan
 *
 * This uses a mkcert-issued cert from `.certs/` (trusted by all local
 * browsers after `mkcert -install` is run once on this machine).  If
 * the cert files are absent, Vite falls back to the @vitejs/plugin-basic-ssl
 * auto-generated self-signed cert (requires a one-time click-through).
 * Regenerate the cert with:
 *
 *   mkcert -cert-file .certs/cert.pem -key-file .certs/key.pem \
 *     localhost MacBook-Pro.local 192.168.1.110
 *
 * Plain `pnpm dev` (no env var) stays on HTTP for local localhost
 * development so HMR websocket behaviour is unaffected.
 */

import basicSsl from '@vitejs/plugin-basic-ssl';

const useHttps = !!process.env.VITE_HTTPS && !process.env.GITHUB_ACTIONS;

// Use mkcert cert files if present, otherwise fall back to basicSsl plugin.
const certPath = path.resolve('.certs/cert.pem');
const keyPath  = path.resolve('.certs/key.pem');
const hasMkcert = useHttps && fs.existsSync(certPath) && fs.existsSync(keyPath);

export default defineConfig({
  plugins: useHttps && !hasMkcert ? [basicSsl()] : [],
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
    https: hasMkcert
      ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
      : useHttps || undefined,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // Retained for environments where HTTPS is not used — satisfies
      // the PNA preflight on best-effort basis (subject to Chrome's
      // 200 ms preflight timeout, which can cause intermittent failures).
      'Access-Control-Allow-Private-Network': 'true',
    },
  },
});
