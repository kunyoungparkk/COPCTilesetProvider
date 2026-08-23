/** Types for `worker-source.mjs`. Kept minimal: only what callers name. */
export declare function workerSource(file: string | undefined): {
  name: string;
  resolveId(id: string): string | null;
  load(id: string): string | null;
};
