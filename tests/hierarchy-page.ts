import type { HierarchyPage } from '../src/copc/index.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';

/** One COPC hierarchy entry, in the form the file stores rather than the form we read. */
export interface PageEntryBytes {
  readonly key: readonly [number, number, number, number];
  /** Chunk offset when pointCount > 0, child page offset when it is -1, else 0. */
  readonly offset: number;
  /** Chunk length, page length, or 0 — matching `offset`. */
  readonly byteSize: number;
  /** > 0 points, -1 for a child page, 0 for a node that has none. */
  readonly pointCount: number;
}

const ENTRY_BYTES = 32;

/**
 * Encodes entries as COPC 1.0 hierarchy bytes.
 *
 * The layout is the specification's: `VoxelKey` as four little-endian int32,
 * then a uint64 offset, an int32 byteSize, and an int32 pointCount. Written by
 * hand because the pinned fixture has no sub-pages, no empty nodes and no
 * gaps, so the tile-tree builder Task 5 adds has no real page to exercise
 * those branches against. `tests/hierarchy-page.test.ts` checks copc.js reads
 * back what this writes, so a constructed page is evidence rather than a
 * private convention.
 */
export function encodeHierarchyPage(entries: readonly PageEntryBytes[]): Uint8Array {
  const bytes = new Uint8Array(entries.length * ENTRY_BYTES);
  const view = new DataView(bytes.buffer);

  entries.forEach((entry, index) => {
    const at = index * ENTRY_BYTES;
    const [depth, x, y, z] = entry.key;
    view.setInt32(at, depth, true);
    view.setInt32(at + 4, x, true);
    view.setInt32(at + 8, y, true);
    view.setInt32(at + 12, z, true);
    view.setBigUint64(at + 16, BigInt(entry.offset), true);
    view.setInt32(at + 24, entry.byteSize, true);
    view.setInt32(at + 28, entry.pointCount, true);
  });

  return bytes;
}

/**
 * The same bytes, read through the library's own reader rather than around it.
 *
 * The mock reader hands back the whole encoded page regardless of the
 * `ByteRange` `readHierarchyPage` asks for, so this does not check that the
 * range itself is correct — `tests/copc-hierarchy.test.ts` pins that.
 */
export function hierarchyPageOf(entries: readonly PageEntryBytes[]): Promise<HierarchyPage> {
  const bytes = encodeHierarchyPage(entries);
  const reader = {
    url: 'https://host/constructed.copc.laz',
    read: () => Promise.resolve({ bytes: bytes.buffer.slice(0) as ArrayBuffer, totalBytes: null }),
    readMany: () => Promise.reject(new Error('constructed pages are read one at a time')),
    stats: () => ({
      requests: 0,
      retries: 0,
      bytesRequested: 0,
      bytesWasted: 0,
      requestsSaved: 0,
    }),
  };

  return readHierarchyPage(reader, { offset: 0, length: bytes.byteLength });
}
