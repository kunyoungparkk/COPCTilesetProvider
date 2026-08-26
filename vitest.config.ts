import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { lazPerfWasm } from './build/laz-perf-wasm.mjs';
import { workerSource } from './build/worker-source.mjs';

export default defineConfig({
  // No `laz-perf` alias here, though the bundle gets the web build. Measured:
  // the web build refuses to start under Node ("not compiled for this
  // environment"), so the suite has to use the Node glue. That divergence is
  // harmless and `tests/worker-lazperf.test.ts` says why — all three of
  // laz-perf's builds ship the same wasm, so only the environment glue
  // differs, never the decoder.
  // `workerSource(undefined)` is not a test double — it is the same plugin the
  // library build runs, given no file. Running from source there is no built
  // Worker to inline, so `virtual:worker-source` is `undefined` and
  // `spawnBundledWorker` throws `WorkerBundleMissingError`. That branch is
  // what the suite covers; `smoke/` covers the other one.
  plugins: [lazPerfWasm(), workerSource(undefined)],
  resolve: {
    alias: {
      // `exports` points at `dist/`, which `npm test` deliberately does not
      // build — the suite stays offline and buildless (CLAUDE.md). The
      // published surface is asserted by `smoke/` instead, against a packed
      // tarball. Longest specifier first: `alias` matches by prefix.
      'copc-tileset-provider/worker': fileURLToPath(
        new URL('./src/worker/browser.ts', import.meta.url),
      ),
      'copc-tileset-provider': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    // The library ships to browsers, but its tests run against pinned
    // fixtures on disk, so Node is the cheaper and more honest environment.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several suites import Cesium's engine source — a large ESM graph pulled
    // through Vite's transform pipeline, once per file because each runs
    // isolated. Some do it in a `beforeAll`, some in the test body, so both
    // clocks need the same allowance for the same reason.
    //
    // Vitest's defaults (10s hooks, 5s tests) hold on a warm Linux checkout
    // and do not on a cold Windows one under full parallel load. Measured
    // here: `tests/worker-pnts.test.ts` failed with `Hook timed out in
    // 10000ms` and `tests/cesium-contract.test.ts` with `Test timed out in
    // 5000ms` — but not on every run and not always the same file, since what
    // decides it is which one loses the race for the machine that time. Both
    // passed alone, and every one of them passed with the clocks raised, so
    // what is being bought here is import time, not a hang.
    //
    // Something that genuinely wedges now takes 30s to say so. The whole
    // suite finishes well inside two minutes, so that is a trade the failure
    // path can afford.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
