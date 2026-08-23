/**
 * `virtual:laz-perf-wasm` has no file behind it — `build/laz-perf-wasm.mjs`
 * synthesises it at build and test time. This declaration is how `tsc` and the
 * editor learn its shape; nothing here reaches the emitted JavaScript.
 */
declare module 'virtual:laz-perf-wasm' {
  const wasmBinary: Uint8Array;
  export default wasmBinary;
}

/**
 * `virtual:worker-source` is the built Worker bundle's own text, injected by
 * `build/worker-source.mjs`. It is `undefined` outside a bundle — running from
 * source, there is no built Worker to inline — which is why the type is
 * optional and why `spawnBundledWorker` checks before using it.
 */
declare module 'virtual:worker-source' {
  const source: string | undefined;
  export default source;
}
