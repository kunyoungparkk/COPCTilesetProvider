import { createWorkerHandler } from './entry.js';
import type { FromWorker, ToWorker } from './protocol.js';

export { createWorkerHandler };

/**
 * What this module needs from a Worker global, written out rather than
 * imported.
 *
 * The alternative is TypeScript's `WebWorker` lib, which cannot share a
 * program with `DOM` — `tsconfig.json` says as much. A second tsconfig for
 * one file costs more than these five lines, so the lines win.
 */
export interface WorkerScope {
  onmessage: ((event: { data: ToWorker }) => void) | null;
  postMessage(message: FromWorker, options?: { transfer: ArrayBuffer[] }): void;
}

/** Wires `scope` to a fresh handler. Exported so a test can drive it. */
export function installWorkerHandler(scope: WorkerScope): void {
  const handle = createWorkerHandler((message, transfer) => {
    scope.postMessage(message, { transfer: transfer as ArrayBuffer[] });
  });
  scope.onmessage = (event) => {
    void handle(event.data);
  };
}

/**
 * A Worker realm has `self` and no `window`. A page has both, and Node has
 * neither — so this is false everywhere except where installing is what the
 * importer wanted.
 */
function currentWorkerScope(): WorkerScope | undefined {
  const global = globalThis as { self?: unknown; window?: unknown };
  if (global.window !== undefined) return undefined;
  const scope = global.self;
  if (scope === undefined || scope === null) return undefined;
  return scope as WorkerScope;
}

const scope = currentWorkerScope();
if (scope !== undefined) installWorkerHandler(scope);
