/** Types for `laz-perf-wasm.mjs`. Kept minimal: only what callers name. */
export declare const WASM_SPECIFIER: string;
export declare function wasmModuleSource(): string;
export declare function lazPerfWasm(): {
  name: string;
  resolveId(id: string): string | null;
  load(id: string): string | null;
};
