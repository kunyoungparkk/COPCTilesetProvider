import workerSource from 'virtual:worker-source';
import { WorkerBundleMissingError } from '../errors/index.js';
import type { FromWorker, ToWorker, WorkerPort } from '../worker/protocol.js';

/**
 * A browser `Worker` behind `WorkerPort`.
 *
 * `addEventListener` rather than `onmessage =`: `WorkerPort` promises that
 * registering a handler adds to the ones before it, and an assignment would
 * quietly drop every earlier registration.
 */
export function browserPort(worker: Worker): WorkerPort {
  return {
    post: (message: ToWorker, transfer: readonly ArrayBuffer[]) =>
      worker.postMessage(message, transfer as ArrayBuffer[]),
    onMessage: (handler: (message: FromWorker) => void) =>
      worker.addEventListener('message', (event) => handler(event.data as FromWorker)),
    onError: (handler: (error: Error) => void) =>
      worker.addEventListener('error', (event) => handler(new Error(event.message))),
    terminate: () => worker.terminate(),
  };
}

/**
 * The Worker `fromUrl` makes when the caller supplies none.
 *
 * The bundle's text is inlined into this library, so the Worker comes from a
 * Blob URL rather than a file — no path to resolve, no asset for a consumer to
 * copy, and no dependence on their bundler understanding a worker convention
 * (OVERVIEW §5: a self-contained Worker bundle).
 *
 * A strict `worker-src` CSP blocks `blob:`, and there is nothing this library
 * can do about that. `spawnWorker` and the `./worker` subpath are the way out.
 */
export function spawnBundledWorker(): WorkerPort {
  if (workerSource === undefined) throw new WorkerBundleMissingError();
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  try {
    return browserPort(new Worker(url, { type: 'module' }));
  } finally {
    // The Worker holds its own reference to the script once constructed, so
    // the URL has done its job either way.
    URL.revokeObjectURL(url);
  }
}
