import { createTransformFromDefinition } from '../crs/worker.js';
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
  let definition: string | undefined;
  let geoidHeight: number | undefined;

  return async (message) => {
    if (message.kind === 'init') {
      // Building a transform here is what proves the definition is usable in
      // this realm before any tile depends on it: `createTransformFromDefinition`
      // refuses a `+nadgrids` table or a `proj4.defs` alias, neither of which
      // a Worker can resolve.
      try {
        // The result is discarded: `encodeNode` builds its own per call, and
        // §7 takes an optimisation from measurement rather than from
        // reasoning. What this call is for is the throw.
        createTransformFromDefinition(message.definition, message.geoidHeight);
        definition = message.definition;
        geoidHeight = message.geoidHeight;
        post({ kind: 'ready', id: message.id }, []);
      } catch (thrown) {
        post({ kind: 'failed', id: message.id, error: toWire(thrown) }, []);
      }
      return;
    }

    if (definition === undefined) {
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
        definition,
        ...(geoidHeight !== undefined && { geoidHeight }),
      });
      post({ kind: 'done', id: message.id, pnts }, [pnts]);
    } catch (thrown) {
      post({ kind: 'failed', id: message.id, error: toWire(thrown) }, []);
    }
  };
}
