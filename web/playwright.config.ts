import { defineConfig } from '@playwright/test';

// Goldens are rendered on the WebGL2 backend with SwiftShader: headless WebGPU
// canvases cannot be captured reliably, and software GL is the same everywhere.
export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/__goldens__/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1024, height: 640 },
    deviceScaleFactor: 1,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: { command: 'npx vite --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true },
});
