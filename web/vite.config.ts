import { defineConfig } from 'vite';
import { live } from './live-relay.ts';

// The wasm core uses threads, so every response must be cross-origin isolated.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => ({
  base: './',
  // The live-link relay (docs/live.md) answers /live/* on the page's origin in dev, preview and the e2e server.
  plugins: [
    {
      name: 'live-relay',
      configureServer: (server) => void server.middlewares.use((req, res, next) => live(req, res) || next()),
      configurePreviewServer: (server) => void server.middlewares.use((req, res, next) => live(req, res) || next()),
    },
  ],
  // The library build ships only the element; hosts serve public/core/ themselves.
  publicDir: mode === 'lib' ? false : 'public',
  // three's addons import 'three'; point them at the same WebGPU entry the app uses.
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { headers: isolation },
  preview: { headers: isolation },
  build:
    mode === 'lib'
      ? {
          outDir: 'dist-lib',
          lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'usd-viewer' },
          rolldownOptions: { external: [/^three($|\/)/] },
        }
      : { outDir: 'dist' },
}));
