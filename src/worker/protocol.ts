import type { WireError } from '../errors/index.js';
import type { DecodeHeader } from './index.js';

/**
 * The messages the two realms exchange, and the whole of their agreement.
 *
 * There is no `cancel` message, deliberately. A task the pool has not posted
 * yet is cancelled by the pool forgetting it — the Worker never heard of it.
 * A task it has posted is inside a synchronous laz-perf decode that owns the
 * Worker's event loop, so a cancel message would not be read until the work
 * it meant to stop had already finished. Adding one anyway would be adding a
 * message that cannot do its job.
 */
export type ToWorker =
  | {
      readonly kind: 'init';
      readonly id: number;
      readonly definition: string;
      /**
       * OVERVIEW §6's geoid offset, in metres. Optional on the wire so the
       * default has one owner — `createTransformFromDefinition` — rather than
       * one per hop. A hand-written handler (see `ToWorker`'s export doc in
       * `src/index.ts`) must forward this to that function itself — it is not
       * applied anywhere else, so dropping it silently mislocates every point
       * relative to the bounding volumes and geometric error the main thread
       * already corrected.
       */
      readonly geoidHeight?: number;
    }
  | {
      readonly kind: 'encode';
      readonly id: number;
      readonly compressed: ArrayBuffer;
      readonly header: DecodeHeader;
      readonly pointCount: number;
    };

/** The Worker realm's replies to a `ToWorker` message, carrying back the same `id` it answers. */
export type FromWorker =
  | { readonly kind: 'ready'; readonly id: number }
  | { readonly kind: 'done'; readonly id: number; readonly pnts: ArrayBuffer }
  | { readonly kind: 'failed'; readonly id: number; readonly error: WireError };

/**
 * One Worker, as much of it as this library needs.
 *
 * A browser `Worker` and a `node:worker_threads` one are not structurally
 * compatible — `addEventListener` against `on` — so one of them needs an
 * adapter whatever we do. Naming the four methods we actually use keeps the
 * DOM's `Transferable` out of a library that must typecheck under
 * `@types/node`, and states the whole platform surface in one place.
 *
 * `ArrayBuffer[]` rather than `Transferable[]`: buffers are the only thing
 * this protocol ever transfers.
 */
export interface WorkerPort {
  post(message: ToWorker, transfer: readonly ArrayBuffer[]): void;
  /**
   * Adds `handler`, the way `worker.on('message', ...)` does — it does not
   * replace a handler registered by an earlier call. `pool.ts` itself only
   * ever registers one, right after `spawn()` returns the port, but a
   * caller driving a port directly is not limited to that: `nextMessage` in
   * `tests/worker-entry.test.ts` calls this once per reply it awaits,
   * relying on every earlier registration still firing.
   */
  onMessage(handler: (message: FromWorker) => void): void;
  /** Same adds-rather-than-replaces contract as `onMessage` — see its doc. */
  onError(handler: (error: Error) => void): void;
  terminate(): void;
}
