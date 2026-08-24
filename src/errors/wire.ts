import { CopcTilesetError } from './base.js';
import { LeaseAlreadyReleasedError, RangeRequestRejectedError } from './budget.js';
import {
  MalformedHierarchyError,
  NotCopcError,
  UnsupportedHeaderLayoutError,
  UnsupportedPointFormatError,
  WktNotInVlrsError,
} from './copc.js';
import {
  CrsCodeNotFoundError,
  CrsDefinitionUnusableError,
  CrsGeoidHeightNotFiniteError,
  CrsNotRegisteredError,
} from './crs.js';
import {
  InvalidSourceUrlError,
  InvalidTokenBaseError,
  WorkerBundleMissingError,
} from './provider.js';
import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  InvalidByteRangeError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
  UnknownTileRequestError,
} from './range.js';
import {
  DecodeJobNotAdmittedError,
  PositionCountMismatchError,
  WorkerTaskFailedError,
  ZeroPointChunkError,
} from './worker.js';

/**
 * A thrown value flattened into something `postMessage` can carry.
 *
 * `code` is `null` for anything this library did not throw.
 */
export interface WireError {
  readonly code: string | null;
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

// Every error class this library can throw, by its code. `tests/errors-wire.test.ts`
// scans src/errors for `readonly code` declarations and fails if one is missing
// here, because a missing entry degrades that error to WorkerTaskFailedError on
// the way back and nothing else would notice.
// Only `.prototype` is ever read, so the value type says that and nothing more.
const BY_CODE: ReadonlyMap<string, { readonly prototype: CopcTilesetError }> = new Map<
  string,
  { readonly prototype: CopcTilesetError }
>([
  ['content-range-mismatch', ContentRangeMismatchError],
  ['content-range-unreadable', ContentRangeUnreadableError],
  ['crs-code-not-found', CrsCodeNotFoundError],
  ['crs-definition-unusable', CrsDefinitionUnusableError],
  ['crs-geoid-height-not-finite', CrsGeoidHeightNotFiniteError],
  ['crs-not-registered', CrsNotRegisteredError],
  ['decode-job-not-admitted', DecodeJobNotAdmittedError],
  ['invalid-byte-range', InvalidByteRangeError],
  ['invalid-source-url', InvalidSourceUrlError],
  ['invalid-token-base', InvalidTokenBaseError],
  ['lease-already-released', LeaseAlreadyReleasedError],
  ['malformed-hierarchy', MalformedHierarchyError],
  ['not-copc', NotCopcError],
  ['position-count-mismatch', PositionCountMismatchError],
  ['range-network', RangeNetworkError],
  ['range-request-failed', RangeRequestFailedError],
  ['range-request-rejected', RangeRequestRejectedError],
  ['range-timeout', RangeTimeoutError],
  ['range-unsupported', RangeUnsupportedError],
  ['unknown-tile-request', UnknownTileRequestError],
  ['unsupported-header-layout', UnsupportedHeaderLayoutError],
  ['unsupported-point-format', UnsupportedPointFormatError],
  ['wkt-not-in-vlrs', WktNotInVlrsError],
  ['worker-bundle-missing', WorkerBundleMissingError],
  ['worker-task-failed', WorkerTaskFailedError],
  ['zero-point-chunk', ZeroPointChunkError],
]);

/** Flattens anything a Worker can throw. */
export function toWire(thrown: unknown): WireError {
  if (thrown instanceof CopcTilesetError) {
    return { code: thrown.code, name: thrown.name, message: thrown.message, stack: thrown.stack };
  }
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  return { code: null, name: error.name, message: error.message, stack: error.stack };
}

/**
 * Rebuilds the error the Worker threw.
 *
 * The instance is built from the prototype rather than by calling the
 * constructor, because the constructors take different arguments — an EPSG
 * code, a url and a detail, nothing at all — and none of those arguments
 * crossed the boundary. The composed message did, and it is the part callers
 * read. Rebuilding it any other way would need the arguments back.
 */
export function fromWire(wire: WireError): CopcTilesetError {
  const constructor = wire.code === null ? undefined : BY_CODE.get(wire.code);
  if (constructor === undefined) {
    return new WorkerTaskFailedError(wire.name, wire.message);
  }
  const rebuilt = Object.create(constructor.prototype) as { name: string; code: string };
  // `code` and `name` are ordinary assignments in the classes themselves — a
  // class field and `this.name = new.target.name` — so they are enumerable on
  // a natively thrown error. `message` and `stack` come from the `Error`
  // constructor, which defines them non-enumerable. Assigning all four plainly
  // would make a rebuilt error serialise differently from a thrown one:
  // `JSON.stringify` and `Object.keys` would show two extra fields. Matching
  // the descriptors makes `name`, `message`, and `stack` (carried across
  // unchanged, not regenerated) genuinely identical to the original's.
  //
  // That is narrower than "indistinguishable", though. `Object.create`
  // builds `rebuilt` without ever calling `Error`, so `util.types.isNativeError`
  // is `false` on it and `Object.prototype.toString` reads `[object Object]`,
  // not `[object Error]`; `structuredClone` carries across only `name` and
  // `code`, since `message`/`stack` are non-enumerable. And any subclass
  // field beyond `code` is not reconstructed at all — its value survives
  // only inside the already-composed `message` text. Concretely, on the one
  // extra-field class a Worker actually throws and this module actually
  // rebuilds, `CrsDefinitionUnusableError`: `rebuilt.definition` and
  // `rebuilt.reason` both read `undefined`, not the original's values.
  // `reason` is typed `'grid-shift' | 'alias' | 'missing-projection'`, so a
  // `switch (error.reason)` on a rebuilt instance typechecks and silently
  // falls through every case. Nothing on a current path reads a rebuilt
  // error's identity or its subclass fields directly, so none of
  // this matters yet, but it is not the same object shape a `catch` in this
  // realm would have produced.
  // `name` before `code`, because that is the order a real construction
  // produces them in: `CopcTilesetError`'s constructor sets `name` while the
  // subclass's `code` field initialises after `super()` returns. Property
  // order is observable through `JSON.stringify`.
  rebuilt.name = wire.name;
  rebuilt.code = wire.code as string;
  Object.defineProperty(rebuilt, 'message', {
    value: wire.message,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(rebuilt, 'stack', {
    value: wire.stack,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return rebuilt as unknown as CopcTilesetError;
}
