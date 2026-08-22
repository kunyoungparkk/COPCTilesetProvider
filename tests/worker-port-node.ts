import { Worker } from 'node:worker_threads';
import type { FromWorker, WorkerPort } from '../src/worker/protocol.js';

const WORKER_ENTRY = new URL('./worker-entry-node.ts', import.meta.url);
const HOOK = new URL('./worker-hook.mjs', import.meta.url);

/**
 * A `WorkerPort` backed by a real `node:worker_threads.Worker`, driving
 * `../src/worker/entry.js`'s handler through `worker-entry-node.ts`'s
 * bootstrap.
 *
 * This is test-only scaffolding, not a shipping platform adapter: `execArgv`
 * registers `worker-hook.mjs`, which lets the Worker's `.js` specifiers
 * resolve against this repository's `.ts` sources — a resolution production
 * never needs, because production loads the Rollup bundle OVERVIEW §5 calls
 * for.
 */
export function createNodeWorkerPort(): WorkerPort {
  const worker = new Worker(WORKER_ENTRY, { execArgv: ['--import', HOOK.href] });

  return {
    post(message, transfer) {
      worker.postMessage(message, transfer as ArrayBuffer[]);
    },
    onMessage(handler: (message: FromWorker) => void) {
      worker.on('message', handler);
    },
    onError(handler) {
      worker.on('error', handler);
    },
    terminate() {
      void worker.terminate();
    },
  };
}
