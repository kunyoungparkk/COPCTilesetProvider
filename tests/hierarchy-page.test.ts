import { Hierarchy } from 'copc';
import { describe, expect, it } from 'vitest';
import { encodeHierarchyPage, hierarchyPageOf } from './hierarchy-page.js';

describe('the hand-built hierarchy page', () => {
  // The point of this file. Every constructed page in the tileset tests is
  // only evidence if copc.js agrees it is a page, so the encoder is checked
  // against the parser the library itself uses rather than against itself.
  it('is read back by copc.js as what was written', () => {
    const bytes = encodeHierarchyPage([
      { key: [0, 0, 0, 0], offset: 1_000, byteSize: 40, pointCount: 7 },
      { key: [1, 0, 0, 0], offset: 2_000, byteSize: 64, pointCount: -1 },
      { key: [1, 1, 0, 0], offset: 0, byteSize: 0, pointCount: 0 },
      // y, z and an offset above 2^32 so a transposed field or a
      // truncated offset write shows up as a wrong key or a wrong number
      // rather than passing unnoticed — the other three entries share
      // y = 0, z = 0 and offsets that fit in 32 bits.
      { key: [3, 1, 2, 5], offset: 4_294_967_400, byteSize: 8, pointCount: 3 },
    ]);

    // 32 bytes per entry is the specification's own figure, and copc.js
    // rejects any page whose length is not a multiple of it.
    expect(bytes.byteLength).toBe(128);

    const subtree = Hierarchy.parse(bytes);

    expect(subtree.nodes['0-0-0-0']).toEqual({
      pointCount: 7,
      pointDataOffset: 1_000,
      pointDataLength: 40,
    });
    // The -1 sentinel is the whole reason this cross-check exists: it decides
    // which of two maps an entry lands in, and nothing else in the bytes says.
    expect(subtree.pages['1-0-0-0']).toEqual({ pageOffset: 2_000, pageLength: 64 });
    expect(subtree.nodes['1-0-0-0']).toBeUndefined();
    // A zero-point entry is a node, with no bytes behind it.
    expect(subtree.nodes['1-1-0-0']).toEqual({
      pointCount: 0,
      pointDataOffset: 0,
      pointDataLength: 0,
    });
    expect(subtree.nodes['3-1-2-5']).toEqual({
      pointCount: 3,
      pointDataOffset: 4_294_967_400,
      pointDataLength: 8,
    });
  });

  it('reaches the tileset tests through the library’s own reader', async () => {
    // hierarchyPageOf goes through readHierarchyPage rather than around it, so
    // a test page meets the same key parsing and length checks a real one does.
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 1_000, byteSize: 40, pointCount: 7 },
      { key: [1, 0, 0, 0], offset: 2_000, byteSize: 64, pointCount: -1 },
    ]);

    expect(page.nodes).toEqual([
      { key: { depth: 0, x: 0, y: 0, z: 0 }, offset: 1_000, length: 40, pointCount: 7 },
    ]);
    expect(page.pages).toEqual([
      { key: { depth: 1, x: 0, y: 0, z: 0 }, offset: 2_000, length: 64 },
    ]);
  });
});
