// rolldown rather than rollup: TypeScript 7 does not expose the compiler API
// `@rollup/plugin-typescript` needs, and rolldown strips types natively
// through oxc. See the spec's §11 for the measurement. Vite 8 runs on rolldown
// too, so the demo and the library share one bundler.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'rolldown';
import { lazPerfWasm } from './build/laz-perf-wasm.mjs';
import { workerSource } from './build/worker-source.mjs';

const WORKER_OUT = fileURLToPath(new URL('./dist/worker.js', import.meta.url));
const LAZ_PERF_WEB = fileURLToPath(
  new URL('./node_modules/laz-perf/lib/web/index.js', import.meta.url),
);

// Every declared dependency stays external in the library bundle (spec §3.1):
// a consumer installs and dedupes them. Only the Worker is self-contained,
// which is the whole point of it.
const EXTERNAL = ['cesium', 'copc', 'proj4'];

export default defineConfig([
  {
    input: 'src/worker/browser.ts',
    output: { file: 'dist/worker.js', format: 'es' },
    platform: 'browser',
    // Belt-and-braces: laz-perf's own `browser` field already selects this
    // build, measured byte-identical either way. Named here because that
    // field is not ours to rely on.
    resolve: { alias: { 'laz-perf': LAZ_PERF_WEB } },
    plugins: [lazPerfWasm()],
  },
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.js', format: 'es' },
    platform: 'browser',
    external: EXTERNAL,
    plugins: [workerSource(WORKER_OUT)],
  },
]);
