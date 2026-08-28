import type { CrsTransform } from '../crs/worker.js';
import { ZeroPointChunkError } from '../errors/index.js';
import type { DecodeHeader } from './decode.js';
import { decodeChunk } from './decode.js';
import { encodePnts } from './pnts.js';
import { toRelativePositions } from './positions.js';

/**
 * One COPC chunk's compressed bytes, the hierarchy's own account of how many
 * points it holds, and the transform to place them with.
 *
 * A built `CrsTransform`, not the definition it came from: it is fixed for a
 * Worker's whole life (`init` carries the definition and the geoid height
 * once, `protocol.ts`), so `entry.ts` builds it there and every chunk reuses
 * that one.
 *
 * Not a speed change, and worth saying so before someone reads one into it:
 * building a transform measures 9.9µs here, against roughly 86ms to encode one
 * of this fixture's 30k-point nodes — four orders of magnitude apart. What it
 * buys is that the transform `init` validated is the one every chunk then
 * uses, rather than an equal-but-separately-rebuilt one per message.
 */
export interface EncodeNodeInput {
  compressed: Uint8Array;
  header: DecodeHeader;
  pointCount: number;
  transform: CrsTransform;
}

/**
 * The Worker's single entry point, composing the three pipeline stages
 * OVERVIEW §4 names for a point tile: decode, transform to ECEF, encode PNTS.
 *
 * Nothing here resolves a coordinate system — that is the boundary this file
 * exists to hold, and taking an already-built transform is the strongest form
 * of it. `resolveCrsDefinition` runs once, on the main thread, at `fromUrl`
 * time, and throws `CrsNotRegisteredError` and `CrsCodeNotFoundError` — errors
 * that have to surface where `fromUrl` can reject. Decision 3 gives a Worker
 * its own copy of module state, so calling it inside a Worker would see none
 * of what the caller registered (rejecting every real file) and the same throw
 * would arrive at the caller as an opaque `messageerror` rather than a typed
 * rejection. Only the resolved answer — a plain string a postMessage can carry
 * — crosses the realm boundary, and `entry.ts` turns it into the transform
 * this takes, importing `createTransformFromDefinition` from
 * `../crs/worker.js`, which cannot reach the registry or the resolver
 * (`tests/crs-worker-boundary.test.ts`). `tests/worker-boundary.test.ts` walks
 * the import closure of this module, of that entry, and of the bundle's own
 * entry the same way, so an import that reaches either one fails the suite
 * rather than only failing in a browser Worker.
 */
export async function encodeNode(input: EncodeNodeInput): Promise<ArrayBuffer> {
  const view = await decodeChunk(input.compressed, input.header, input.pointCount);

  // Checked here — the one place in the pipeline that owns it (Decision 6's
  // empty-node invariant forbids serving a zero-point PNTS by any path) —
  // and nowhere else: neither toRelativePositions nor encodePnts guards
  // against count 0, so a duplicate check here would just name the wrong
  // layer in its own failure message instead of this one.
  //
  // Placed after decodeChunk rather than by testing input.pointCount up
  // front: decodeChunk's own doc comment establishes that its output always
  // has exactly the point count it was asked to decode (there is no
  // independent count to check that against), so testing view.pointCount
  // here is exactly as informative — but doing it here is cheapest, since it
  // skips toRelativePositions's per-point transform loop rather than running
  // it over nothing. For the same reason, this check cannot tell a hierarchy
  // entry that lied about a zero count apart from this library asking
  // decodeChunk for zero points on its own — both produce the same
  // zero-length view, and ZeroPointChunkError's own doc comment says so
  // rather than implying it can distinguish them.
  if (view.pointCount === 0) {
    throw new ZeroPointChunkError();
  }

  const placed = toRelativePositions(view, input.transform);
  return encodePnts(view, placed);
}
