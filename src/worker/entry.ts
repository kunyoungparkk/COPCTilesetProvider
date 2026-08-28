import { createTransformFromDefinition } from '../crs/worker.js';
import type { CrsTransform } from '../crs/worker.js';
import { toWire } from '../errors/index.js';
import { encodeNode } from './index.js';
import type { FromWorker, ToWorker } from './protocol.js';

/**
 * The Worker realm's message handler, without the platform wiring.
 *
 * A browser Worker receives through `self.onmessage` and a
 * `node:worker_threads` one through `parentPort.on('message')`. Hardcoding
 * either would make the other untestable, and testing against a real Worker
 * is the only way structured clone and transferable handoff get checked at
 * all. So the platform-specific wiring — receiving a message and posting a
 * reply — lives in a bootstrap (`tests/worker-entry-node.ts` for
 * `node:worker_threads`) and this file holds everything that does not.
 */
export function createWorkerHandler(
  post: (message: FromWorker, transfer: readonly ArrayBuffer[]) => void,
): (message: ToWorker) => Promise<void> {
  // The one transform this Worker will ever build. `init` carries the
  // definition and the geoid height once and nothing may change them
  // afterwards (`WorkerPoolOptions` fixes both for the pool's whole life), so
  // every chunk projects through this same object.
  //
  // Building it here is also what proves the definition is usable in this
  // realm before any tile depends on it: `createTransformFromDefinition`
  // refuses a `+nadgrids` table or a `proj4.defs` alias, neither of which a
  // Worker can resolve. Assigned only when that succeeds, so a failed init
  // leaves this `undefined` and the guard below refuses every later encode —
  // the invariant is held by this variable rather than by a second throw
  // deeper in the pipeline.
  let transform: CrsTransform | undefined;

  return async (message) => {
    if (message.kind === 'init') {
      try {
        transform = createTransformFromDefinition(message.definition, message.geoidHeight);
        post({ kind: 'ready', id: message.id }, []);
      } catch (thrown) {
        post({ kind: 'failed', id: message.id, error: toWire(thrown) }, []);
      }
      return;
    }

    if (transform === undefined) {
      post(
        {
          kind: 'failed',
          id: message.id,
          error: toWire(new Error('this Worker was asked to encode before it was initialised')),
        },
        [],
      );
      return;
    }

    try {
      const pnts = await encodeNode({
        compressed: new Uint8Array(message.compressed),
        header: message.header,
        pointCount: message.pointCount,
        transform,
      });
      post({ kind: 'done', id: message.id, pnts }, [pnts]);
    } catch (thrown) {
      post({ kind: 'failed', id: message.id, error: toWire(thrown) }, []);
    }
  };
}
