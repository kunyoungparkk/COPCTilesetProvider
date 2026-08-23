import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WASM_SPECIFIER, wasmModuleSource } from '../build/laz-perf-wasm.mjs';

// A `node:worker_threads` Worker loads source directly, with no bundler in
// front of it, so the virtual module `src/worker/lazperf.ts` imports has to be
// answered here too. The text comes from the same function the bundler plugin
// uses, so the Worker under test decodes with the bytes that ship.
const WASM_URL = `virtual:${WASM_SPECIFIER}`;

/**
 * Resolves this repository's `.js` specifiers to the `.ts` files they mean.
 *
 * `src/` uses `.js` specifiers because NodeNext requires them, and Node's
 * native type stripping does not rewrite them, so a Worker started on a
 * source file fails with ERR_MODULE_NOT_FOUND. This is test-only scaffolding:
 * production loads the Rollup bundle OVERVIEW §5 calls for.
 */
export async function resolve(specifier, context, next) {
  if (specifier === WASM_SPECIFIER) {
    return { url: WASM_URL, format: 'module', shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier, context.parentURL);
      asTs.pathname = asTs.pathname.replace(/\.js$/, '.ts');
      if (existsSync(fileURLToPath(asTs))) {
        return next(asTs.href, context);
      }
    }
    throw error;
  }
}

/** Serves the virtual module `resolve` above admits; everything else passes through. */
export async function load(url, context, next) {
  if (url === WASM_URL) {
    return { format: 'module', source: wasmModuleSource(), shortCircuit: true };
  }
  return next(url, context);
}
