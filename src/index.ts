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
export { browserPort } from './cesium-runtime/index.js';
export {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  CrsCodeNotFoundError,
  CrsDefinitionUnusableError,
  CrsGeoidHeightNotFiniteError,
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
  WorkerBundleMissingError,
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
 * The Worker realm's protocol types, for a caller writing their own Worker.
 *
 * `createWorkerHandler` itself is **not** here. It lives at the `./worker`
 * subpath, which is the entry point the Worker realm gets to itself:
 *
 * ```js
 * // your-worker.js
 * import 'copc-tileset-provider/worker';   // installs itself; that is all
 * ```
 *
 * Keeping it on this barrel is what broke before. This entry re-exports
 * `COPCTilesetProvider`, which statically imports `cesium`, and the render
 * gate measured a Worker importing it dying on `ReferenceError: global is not
 * defined` before handling a message (`docs/gate-render-findings.md`). It also
 * dragged the whole Worker realm — laz-perf and its inlined wasm included —
 * into the library bundle, where nothing on the main thread can use it.
 *
 * Most callers need none of this: `fromUrl` builds its own Worker from the
 * bundle inlined into this library. These types are for the ones who pass
 * `spawnWorker` instead, and `browserPort` is the adapter they would otherwise
 * write by hand.
 *
 * A hand-written handler must forward the `init` message's `geoidHeight` to
 * `createTransformFromDefinition` — see `ToWorker`'s own doc comment.
 */
export type { FromWorker, ToWorker } from './worker/protocol.js';
