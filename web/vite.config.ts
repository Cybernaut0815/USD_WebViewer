import { defineConfig } from 'vite';

// The wasm core uses threads, so every response must be cross-origin isolated.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => ({
  base: './',
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
