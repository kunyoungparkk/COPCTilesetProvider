/**
 * The package's entry point (OVERVIEW §1): `COPCTilesetProvider.fromUrl(url)`
 * and everything a caller needs to use it.
 *
 * Every error class below is re-exported for the same reason: errors are
 * part of the API (OVERVIEW §3, Decision 6), and a caller cannot catch a
 * class it cannot import. `fromWire`/`toWire`/`WireError`
 * (`src/errors/wire.ts`) are absent on purpose — they cross the Worker
 * boundary so a decode failure can be rethrown as its original typed error
 * on the main thread, and no caller of this package ever handles a wire
 * form directly.
 */
export type { COPCTilesetProviderOptions, ProviderStats } from './cesium-runtime/index.js';
export { COPCTilesetProvider } from './cesium-runtime/index.js';
export {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  CrsCodeNotFoundError,
  CrsDefinitionUnusableError,
  CrsNotRegisteredError,
  DecodeJobNotAdmittedError,
  InvalidByteRangeError,
  InvalidSourceUrlError,
  InvalidTokenBaseError,
  LeaseAlreadyReleasedError,
  MalformedHierarchyError,
  NotCopcError,
  PositionCountMismatchError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeRequestRejectedError,
  RangeTimeoutError,
  RangeUnsupportedError,
  UnknownTileRequestError,
  UnsupportedHeaderLayoutError,
  UnsupportedPointFormatError,
  WktNotInVlrsError,
  WorkerTaskFailedError,
  ZeroPointChunkError,
} from './errors/index.js';

// `spawnWorker` is a required option and `stats()` is a public method, so the
// types their signatures name have to be nameable too: without these a caller
// can satisfy the option structurally but cannot annotate a variable, write a
// helper that returns one, or type a function that takes the stats. The
// `exports` map is a single path, so there is no deep import to fall back on.
//
// `BudgetCounterStats` is here for the same reason one level down: all four
// of `BudgetStats`'s fields are typed as it, so a caller can read
// `stats().budget.decode.admitted` but could not annotate a helper that takes
// one of those four.
export type { WorkerPort } from './worker/pool.js';
export type { RangeStats } from './range/index.js';
export type { BudgetCounterStats, BudgetStats } from './budget/index.js';

/**
 * The Worker realm's half of the library: `spawnWorker` is required and must
 * return a `WorkerPort` speaking this protocol, and `createWorkerHandler` is
 * the only thing that speaks it. Without these exported, the required option
 * could not be satisfied at all from the package as published — `exports` is
 * a single path, so no deep import reaches `src/worker/entry.ts`.
 *
 * Exported here is not the same as reachable from a Worker, and this entry is
 * a poor front door for one. It also re-exports `COPCTilesetProvider`, which
 * statically imports `cesium`, so a Worker module importing this file gets
 * Cesium in its graph unless the caller's bundler drops it — which the
 * package does nothing to guarantee. Measured once, under Vite 8.2.1 with
 * Cesium 1.143.0: it is not dropped, and the Worker dies on
 * `ReferenceError: global is not defined` before handling a message
 * (`docs/gate-render-findings.md`). Whether another bundler fares better is
 * untested. Until the publish sub-project gives the Worker realm an entry of
 * its own — a `./worker` subpath, a self-contained bundle, or both
 * (`docs/superpowers/plans/carried-forward.md`) — a Worker reaching
 * `createWorkerHandler` is relying on its bundler, not on this package.
 *
 * `ToWorker` and `FromWorker` come with it because `createWorkerHandler`'s
 * own signature names both: the `post` callback it takes is
 * `(message: FromWorker, transfer: readonly ArrayBuffer[]) => void`, and what
 * it returns takes a `ToWorker`. A caller writing the platform wiring around
 * it — `self.onmessage` in a browser, `parentPort.on('message')` in Node —
 * has to name them.
 */
export type { FromWorker, ToWorker } from './worker/protocol.js';
export { createWorkerHandler } from './worker/entry.js';
