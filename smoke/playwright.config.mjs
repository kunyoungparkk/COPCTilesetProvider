// The publish smoke's browser half. Not wired into CI, which stays offline and
// browser-free — `smoke/run.mjs` starts the server this points at.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.SMOKE_PORT ?? 8933}`,
    launchOptions: {
      // Headless Chromium has no GPU here, so WebGL comes from SwiftShader.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
});
