// One plugin, used by both the bundler config and the Vitest config, so that
// source, tests and the published bundle get the wasm through the same path.
// A second implementation is a second thing that can drift, and "works in
// source, breaks in the tarball" is the defect class the publish smoke exists
// to catch (OVERVIEW §5).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPECIFIER = 'virtual:laz-perf-wasm';
const RESOLVED = '\0virtual:laz-perf-wasm';

const WASM = fileURLToPath(
  new URL('../node_modules/laz-perf/lib/web/laz-perf.wasm', import.meta.url),
);

/**
 * The module text, as one function, because three realms need it: the bundler
 * plugin below, Vitest through that same plugin, and the `node:worker_threads`
 * loader hook in `tests/worker-resolve-ts.mjs` — which never sees a bundler at
 * all. Two implementations would be two things to drift.
 */
export function wasmModuleSource() {
  const base64 = readFileSync(WASM).toString('base64');
  // `atob` is in both Node 22 and every browser this library targets, so
  // one decoder serves the Worker realm and the test realm alike. A plain
  // loop rather than `Uint8Array.from(text, mapFn)`: that calls a function
  // per byte, and this runs in every Worker as it starts — measured on the
  // 214 KB wasm, 7.2 ms against 0.8 ms.
  return (
    `const text = atob(${JSON.stringify(base64)});\n` +
    'const bytes = new Uint8Array(text.length);\n' +
    'for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);\n' +
    'export default bytes;\n'
  );
}

export const WASM_SPECIFIER = SPECIFIER;

export function lazPerfWasm() {
  return {
    name: 'laz-perf-wasm',
    resolveId(id) {
      return id === SPECIFIER ? RESOLVED : null;
    },
    load(id) {
      return id === RESOLVED ? wasmModuleSource() : null;
    },
  };
}
