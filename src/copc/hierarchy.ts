import { Hierarchy } from 'copc';
import { MalformedHierarchyError } from '../errors/index.js';
import type { ByteRange, RangeReader } from '../range/index.js';

/** An octree address: depth, then the cell's index on each axis at that depth. */
export interface NodeKey {
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A node's compressed point data, as a byte range in the file.
 *
 * `offset`/`length` are `ByteRange`'s own names on purpose: a descriptor is
 * assignable to `ByteRange`, so it goes to `readMany` with no translation.
 */
export interface NodeDescriptor {
  readonly key: NodeKey;
  readonly offset: number;
  readonly length: number;
  /** Zero is legal. Decision 6 leaves omitting such nodes to the tileset. */
  readonly pointCount: number;
}

/** A hierarchy page that has not been read yet, likewise a `ByteRange`. */
export interface PageDescriptor {
  readonly key: NodeKey;
  readonly offset: number;
  readonly length: number;
}

export interface HierarchyPage {
  readonly nodes: readonly NodeDescriptor[];
  readonly pages: readonly PageDescriptor[];
}

const KEY = /^(\d+)-(\d+)-(\d+)-(\d+)$/;

// `url` is threaded in from the reader rather than read from anywhere global:
// the error names the file whose hierarchy is at fault, so this function
// genuinely depends on it.
function parseKey(url: string, text: string): NodeKey {
  const match = KEY.exec(text);
  const [, depth, x, y, z] = match ?? [];
  if (depth === undefined || x === undefined || y === undefined || z === undefined) {
    // The page parsed but its keys are not octree addresses, so nothing built
    // from them would be meaningful.
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(text)} is not addressed depth-x-y-z`,
    );
  }
  return { depth: Number(depth), x: Number(x), y: Number(y), z: Number(z) };
}

// copc.js reads an entry's length field as a signed Int32, so a corrupt page
// can hand out a negative one. Left alone it reaches formatRangeHeader, which
// refuses it as an InvalidByteRangeError — an error that blames how the request
// was built for a defect that is in the file.
function checkedLength(url: string, key: string, length: number): number {
  if (length < 0) {
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(key)} declares a negative byte length of ${length}`,
    );
  }
  return length;
}

// Three things a node's point count has to agree with, all of them defects
// the file is responsible for.
//
// The first two are the COPC specification's own rule that `Entry::byteSize`
// is "0 if the pointCount is 0" (copc.io, hierarchy VLR section), read in both
// directions. Points with no bytes to hold them is the wrong-blame shape
// checkedLength exists to prevent, one value over: left alone it becomes a
// NodeDescriptor whose byte range nobody can request, and dies in
// formatRangeHeader as InvalidByteRangeError instead of naming the file.
// Bytes reserved for a node holding nothing is the same contradiction the
// other way round, and nothing downstream would ever notice it — Decision 6
// omits content for every zero-point node whatever its length says, so those
// bytes are dropped in silence.
//
// The third is magnitude. A node's points are a subset of the file's, so the
// header's own count bounds every entry. Nobody else bounds it: `decodeChunk`
// hands this number straight to laz-perf, which allocates
// `pointCount * pointDataRecordLength` bytes and fabricates that many points
// from whatever the chunk holds. Measured against the 951-byte, 47-point
// chunk fixture: a claim of 1_000_000 produces a million points in about half
// a second, and copc.js reads the field as a signed Int32, so a page can ask
// for 2_147_483_647 — an allocation V8 refuses with a bare RangeError from
// inside a dependency. Refusing it here costs one comparison and blames the
// file, which is the only thing that can be at fault.
function checkedPointCount(
  url: string,
  key: string,
  pointCount: number,
  length: number,
  filePointCount: number,
): number {
  if (pointCount > 0 && length === 0) {
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(key)} declares ${pointCount} points but a byte length of 0`,
    );
  }
  if (pointCount === 0 && length > 0) {
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(key)} declares no points but reserves ${length} bytes for them`,
    );
  }
  if (pointCount > filePointCount) {
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(key)} declares ${pointCount} points, more than the ` +
        `${filePointCount} the file's own header says it holds`,
    );
  }
  return pointCount;
}

/**
 * Parses hierarchy page bytes already in hand into what the page holds.
 *
 * Split out of `readHierarchyPage` so the codec's hierarchy-tile branch
 * (`src/cesium-runtime/codec.ts`) can reuse the parsing without a `RangeReader`:
 * Cesium hands that branch the page's bytes directly — they already arrived
 * through `ScheduledRangeResource`'s Range read — so asking a reader to fetch
 * them again would be a second round trip for bytes already in memory, one
 * Decision 4 has no budget accounting for because nothing asked for it.
 *
 * `url` names the file in every error the same way `readHierarchyPage` did,
 * `bytes` is the page's raw content, and `filePointCount` is the same bound
 * `readHierarchyPage` requires (see its own doc for why it is not optional).
 */
export function parseHierarchyPage(
  url: string,
  bytes: ArrayBuffer,
  filePointCount: number,
): HierarchyPage {
  // A truncated or padded page, and an out-of-range point count, are the
  // corruptions a real file is likeliest to have. copc.js reports both with a
  // bare Error that carries no code and names no file, so they get the same
  // typed treatment as an unreadable key (Decision 6).
  let subtree: Hierarchy.Subtree;
  try {
    subtree = Hierarchy.parse(new Uint8Array(bytes));
  } catch (cause) {
    throw new MalformedHierarchyError(url, 'its bytes could not be parsed as hierarchy entries', {
      cause,
    });
  }

  const nodes = Object.entries(subtree.nodes).flatMap<NodeDescriptor>(([key, node]) => {
    if (node === undefined) {
      return [];
    }
    const length = checkedLength(url, key, node.pointDataLength);
    return [
      {
        key: parseKey(url, key),
        offset: node.pointDataOffset,
        length,
        pointCount: checkedPointCount(url, key, node.pointCount, length, filePointCount),
      },
    ];
  });

  const pages = Object.entries(subtree.pages).flatMap<PageDescriptor>(([key, sub]) => {
    if (sub === undefined) {
      return [];
    }
    const length = checkedLength(url, key, sub.pageLength);
    // A page-pointer entry exists only because some node's pointCount was the
    // sub-page sentinel (-1), claiming "there is a child page here" — unlike a
    // node's own length, which is legitimately zero for an empty node, a page
    // has no such case: an empty child page could hold none of the entries
    // the pointer claims exist. Left unrefused, a caller re-reading this
    // descriptor would reach `readHierarchyPage`'s zero-length early return
    // and get nothing back rather than a defect naming the file — the same
    // wrong-blame shape checkedPointCount refuses for nodes, applied to a
    // page pointer instead (tests/copc-hierarchy.test.ts, "refuses a sub-page
    // that declares a byte length of zero").
    if (length === 0) {
      throw new MalformedHierarchyError(
        url,
        `its entry ${JSON.stringify(key)} points at a page but declares a byte length of 0`,
      );
    }
    return [{ key: parseKey(url, key), offset: sub.pageOffset, length }];
  });

  return { nodes, pages };
}

/**
 * Reads one hierarchy page and describes what it holds.
 *
 * The read goes through the reader rather than `Hierarchy.load` so that
 * merging stays the transport's job rather than this module's (Decision 4).
 * Actually coalescing two pages into one request needs `readMany` and a way to
 * hand the resulting buffers back in, and neither exists yet: every read on a
 * production path is one `read()` for one range, so `readMany` has no caller
 * outside `src/range/` and no two pages are ever merged.
 *
 * `filePointCount` is the file header's own point count, and it is required
 * rather than optional on purpose: an optional bound defaults to no bound, and
 * a caller that forgets it gets the unchecked behaviour with nothing to say
 * so. Making it part of the signature costs every call site a decision and
 * makes omission a compile error instead of a silent one.
 */
export async function readHierarchyPage(
  reader: RangeReader,
  page: ByteRange,
  filePointCount: number,
  signal?: AbortSignal,
): Promise<HierarchyPage> {
  // Required, not an optimisation: a zero-length range is refused by
  // formatRangeHeader, so asking for one would throw instead of reporting the
  // empty page the file actually describes.
  if (page.length === 0) {
    return { nodes: [], pages: [] };
  }

  const { bytes } = await reader.read(page, signal);
  return parseHierarchyPage(reader.url, bytes, filePointCount);
}
