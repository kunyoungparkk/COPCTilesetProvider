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

/**
 * Reads one hierarchy page and describes what it holds.
 *
 * The read goes through the reader rather than `Hierarchy.load` so that
 * merging stays the transport's job rather than this module's (Decision 4).
 * Actually coalescing two pages into one request needs `readMany` and a way to
 * hand the resulting buffers back in; both arrive with sub-page expansion.
 */
export async function readHierarchyPage(
  reader: RangeReader,
  page: ByteRange,
  signal?: AbortSignal,
): Promise<HierarchyPage> {
  // Required, not an optimisation: a zero-length range is refused by
  // formatRangeHeader, so asking for one would throw instead of reporting the
  // empty page the file actually describes.
  if (page.length === 0) {
    return { nodes: [], pages: [] };
  }

  const { bytes } = await reader.read(page, signal);

  // A truncated or padded page, and an out-of-range point count, are the
  // corruptions a real file is likeliest to have. copc.js reports both with a
  // bare Error that carries no code and names no file, so they get the same
  // typed treatment as an unreadable key (Decision 6).
  let subtree: Hierarchy.Subtree;
  try {
    subtree = Hierarchy.parse(new Uint8Array(bytes));
  } catch (cause) {
    throw new MalformedHierarchyError(
      reader.url,
      'its bytes could not be parsed as hierarchy entries',
      { cause },
    );
  }

  const nodes = Object.entries(subtree.nodes).flatMap<NodeDescriptor>(([key, node]) =>
    node === undefined
      ? []
      : [
          {
            key: parseKey(reader.url, key),
            offset: node.pointDataOffset,
            length: checkedLength(reader.url, key, node.pointDataLength),
            pointCount: node.pointCount,
          },
        ],
  );

  const pages = Object.entries(subtree.pages).flatMap<PageDescriptor>(([key, sub]) =>
    sub === undefined
      ? []
      : [
          {
            key: parseKey(reader.url, key),
            offset: sub.pageOffset,
            length: checkedLength(reader.url, key, sub.pageLength),
          },
        ],
  );

  return { nodes, pages };
}
