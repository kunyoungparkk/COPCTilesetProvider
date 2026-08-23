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
  },
});
