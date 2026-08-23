import { createLazPerf } from 'laz-perf';
import wasmBinary from 'virtual:laz-perf-wasm';

type LazPerf = Awaited<ReturnType<typeof createLazPerf>>;

let instance: Promise<LazPerf> | undefined;

/**
 * The Worker realm's one laz-perf module.
 *
 * `copc.js` would happily build its own — `decompressChunk` falls back to
 * `createLazPerf()` when handed no instance — but that call resolves the
 * `.wasm` against wherever its script was served from, which in a bundled
 * Worker is a URL nothing answers. Passing `wasmBinary` removes the fetch
 * entirely, so there is no file for a consumer to serve and no path for them
 * to get wrong.
 *
 * Memoised because a laz-perf module owns a WASM instance and its heap:
 * building a second one per tile would allocate a fresh heap per decode.
 */
export function getLazPerf(): Promise<LazPerf> {
  const started = instance ?? createLazPerf({ wasmBinary });
  instance = started;
  return started;
}
