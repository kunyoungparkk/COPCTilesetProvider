import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Bounds } from 'copc';
import { describe, expect, it } from 'vitest';
import { readFileHeader } from '../src/copc/header.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';
import { decodeChunk } from '../src/worker/decode.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const URL_ = 'https://host/autzen.copc.laz';

/** A reader that serves one fixed buffer, regardless of the range asked for. */
function bufferReader(bytes: Uint8Array): RangeReader {
  return {
    url: URL_,
    read: (range: ByteRange) =>
      Promise.resolve({
        bytes: bytes.slice(range.offset, range.offset + range.length).buffer as ArrayBuffer,
        totalBytes: null,
      }),
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
}

describe('decodeChunk', () => {
  it('decodes node 5-16-3-1 into a view the hierarchy and header independently confirm', async () => {
    // Two reads of the same file, through the two modules that already own
    // them, neither of which decodeChunk touches. The header and the info
    // VLR's root cube come from readFileHeader (bytes 0-588); the node's
    // declared point count comes from readHierarchyPage over the root
    // hierarchy page fixture — a different byte range, parsed by a
    // different function. Comparing decodeChunk's output against the
    // header's bounds and the pinned point below is a genuine cross-check,
    // not the decoder confirming itself — the point-count comparison next
    // is a narrower claim, addressed where it is made.
    const { header, info } = await readFileHeader(bufferReader(fixture('autzen-head.bin')));
    const page = await readHierarchyPage(bufferReader(fixture('autzen-root-hierarchy.bin')), {
      offset: 0,
      length: fixture('autzen-root-hierarchy.bin').byteLength,
    });
    const entry = page.nodes.find(
      (node) => node.key.depth === 5 && node.key.x === 16 && node.key.y === 3 && node.key.z === 1,
    );
    if (entry === undefined) {
      throw new Error('fixtures/autzen-root-hierarchy.bin no longer has node 5-16-3-1');
    }
    expect(entry.pointCount).toBe(47); // fixtures/README.md: this node's pinned point count

    const compressed = fixture('autzen-node-5-16-3-1.bin');
    const view = await decodeChunk(compressed, header, entry.pointCount);

    // The hierarchy's count, not the decoder's own: decodeChunk hands
    // decompressChunk this same number and never asks the decoder to count
    // anything on its own, so this checks that the hierarchy's value made it
    // through, not that the decoder agrees with itself.
    expect(view.pointCount).toBe(entry.pointCount);

    // The decoder never sees header.min/max, so every decoded point landing
    // inside them is a genuine second source. A hand-run mutation swapping
    // pointDataRecordFormat and pointDataRecordLength (a plausible real
    // defect: the two record fields transposed) faults inside laz-perf
    // before any point is produced, so it never reaches this loop at all.
    const getX = view.getter('X');
    const getY = view.getter('Y');
    const getZ = view.getter('Z');
    for (let i = 0; i < view.pointCount; i++) {
      expect(getX(i)).toBeGreaterThanOrEqual(header.min[0]);
      expect(getX(i)).toBeLessThanOrEqual(header.max[0]);
      expect(getY(i)).toBeGreaterThanOrEqual(header.min[1]);
      expect(getY(i)).toBeLessThanOrEqual(header.max[1]);
      expect(getZ(i)).toBeGreaterThanOrEqual(header.min[2]);
      expect(getZ(i)).toBeLessThanOrEqual(header.max[2]);
    }

    // The header's own bounds are the whole file's extent — Autzen is
    // 3426 x 4655 x 209 m in X/Y/Z — so a wrong scale can still decode
    // "inside the file" without being anywhere near this node. The node's
    // own octree cube, stepped down from the info VLR's root cube by this
    // node's key, is far tighter (about 145 m in X here, roughly 23x
    // narrower than the header) and every real point must fall inside it.
    // Checked separately from the header bounds above because Step 1 asks
    // for the header's own min/max specifically; this closes the gap that
    // check leaves.
    const nodeCube = Bounds.stepTo(info.cube, [
      entry.key.depth,
      entry.key.x,
      entry.key.y,
      entry.key.z,
    ]);
    for (let i = 0; i < view.pointCount; i++) {
      expect(getX(i)).toBeGreaterThanOrEqual(nodeCube[0]);
      expect(getX(i)).toBeLessThanOrEqual(nodeCube[3]);
      expect(getY(i)).toBeGreaterThanOrEqual(nodeCube[1]);
      expect(getY(i)).toBeLessThanOrEqual(nodeCube[4]);
      expect(getZ(i)).toBeGreaterThanOrEqual(nodeCube[2]);
      expect(getZ(i)).toBeLessThanOrEqual(nodeCube[5]);
    }

    // Point 0, pinned by hand. Its raw int32s, read directly from the
    // decompressed 36-byte record (recovered with a throwaway script over
    // this same fixture, format 7 / length 36): X=64139, Y=-188300, Z=4107.
    // The header's scale is [0.01, 0.01, 0.01] and offset is
    // [637290.75, 851209.9, 510.7] (`Las.Header.parse` on
    // fixtures/autzen-head.bin), so:
    //   X = 64139  * 0.01 + 637290.75 = 637932.14
    //   Y = -188300 * 0.01 + 851209.9  = 849326.9
    //   Z = 4107   * 0.01 + 510.7     = 551.77
    // `Las.View`'s getters apply exactly this arithmetic themselves
    // (node_modules/copc/lib/las/extractor.js), so these are the values it
    // must hand back — not a copy of what decodeChunk computed, since
    // decodeChunk performs no scale/offset arithmetic at all.
    expect(getX(0)).toBeCloseTo(637932.14, 6);
    expect(getY(0)).toBeCloseTo(849326.9, 6);
    expect(getZ(0)).toBeCloseTo(551.77, 6);
  });
});
