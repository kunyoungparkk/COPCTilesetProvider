import { describe, expect, it } from 'vitest';
import { hierarchyPageOf } from './hierarchy-page.js';
import { buildTileTree, keyText } from '../src/tileset/tree.js';

const ROOT = { depth: 0, x: 0, y: 0, z: 0 };
const URL = 'https://host/constructed.copc.laz';

describe('buildTileTree', () => {
  it('nests entries by octree parentage', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 1, 0, 1], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [2, 3, 1, 2], offset: 300, byteSize: 30, pointCount: 7 },
    ]);

    // 2-3-1-2's parent is (1, 3>>1, 1>>1, 2>>1) = 1-1-0-1, which is present, so
    // nothing is synthesised and the chain is three deep. The three axes carry
    // different values on purpose: with y and z both zero, a parentOf that
    // transposed them would pass.
    const tree = buildTileTree(URL, page, ROOT);

    expect(tree.synthesizedAncestors).toBe(0);
    expect(keyText(tree.root.key)).toBe('0-0-0-0');
    expect(tree.root.children.map((child) => keyText(child.key))).toEqual(['1-1-0-1']);
    expect(tree.root.children[0]?.children.map((child) => keyText(child.key))).toEqual(['2-3-1-2']);
  });

  it('gives a zero-point node a tile but no entry', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 0, byteSize: 0, pointCount: 0 },
      { key: [1, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    const tree = buildTileTree(URL, page, ROOT);

    // The specification's own case: "no point data exists for this key, though
    // may exist for child entries". It is not synthesised — the page named it.
    expect(tree.root.entry).toBeUndefined();
    expect(tree.root.synthesized).toBe(false);
    expect(tree.synthesizedAncestors).toBe(0);
    expect(tree.root.children).toHaveLength(1);
  });

  it('registers a page pointer as hierarchy, not as points', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 0], offset: 900, byteSize: 64, pointCount: -1 },
    ]);

    const tree = buildTileTree(URL, page, ROOT);

    expect(tree.root.children[0]?.entry).toEqual({
      kind: 'hierarchy',
      key: { depth: 1, x: 0, y: 0, z: 0 },
      offset: 900,
      length: 64,
    });
  });

  it('synthesises the ancestors a gap skipped, counting tiles', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [3, 7, 2, 5], offset: 300, byteSize: 30, pointCount: 7 },
    ]);

    // 3-7-2-5's parents are 2-3-1-2 and 1-1-0-1, neither present. One gap,
    // two levels, so two tiles — which is exactly the ambiguity the count's
    // definition resolves: tiles, not gaps and not files.
    const tree = buildTileTree(URL, page, ROOT);

    expect(tree.synthesizedAncestors).toBe(2);
    const level1 = tree.root.children[0];
    const level2 = level1?.children[0];
    expect(keyText(level1?.key ?? ROOT)).toBe('1-1-0-1');
    expect(level1?.synthesized).toBe(true);
    // A skeleton: no entry, so no content and no byte range will be emitted.
    expect(level1?.entry).toBeUndefined();
    expect(keyText(level2?.key ?? ROOT)).toBe('2-3-1-2');
    expect(level2?.synthesized).toBe(true);
    expect(keyText(level2?.children[0]?.key ?? ROOT)).toBe('3-7-2-5');
    expect(level2?.children[0]?.synthesized).toBe(false);
  });

  it('refuses a key that is both a node and a page pointer', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [1, 0, 0, 0], offset: 900, byteSize: 64, pointCount: -1 },
    ]);

    // A format violation, not an incomplete tree: two entries disagree about
    // where 1-0-0-0's data lives, and nothing here can choose between them.
    expect(() => buildTileTree(URL, page, ROOT)).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    expect(() => buildTileTree(URL, page, ROOT)).toThrow('1-0-0-0');
  });

  it('refuses an entry from outside the page’s own subtree', async () => {
    const page = await hierarchyPageOf([
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [2, 2, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    // Rooted at 1-0-0-0: its eight depth-2 descendants are every 2-x-y-z
    // with x, y, z each in {0, 1}. 2-2-0-0 has x=2, so it isn't one of
    // them — its real parent is (1, 2>>1, 0>>1, 0>>1) = 1-1-0-0, a
    // sibling's page.
    expect(() => buildTileTree(URL, page, { depth: 1, x: 0, y: 0, z: 0 })).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    // Pinned so a mutation that keeps the right error type but loses the
    // offending key from the message — the message is the diagnosis — still
    // fails, the way the node/page-pointer test already pins '1-0-0-0'.
    expect(() => buildTileTree(URL, page, { depth: 1, x: 0, y: 0, z: 0 })).toThrow('2-2-0-0');
  });

  it('refuses a subtree violation on the y axis alone', async () => {
    const rootKey = { depth: 1, x: 1, y: 0, z: 1 };
    const page = await hierarchyPageOf([
      { key: [1, 1, 0, 1], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [2, 3, 3, 2], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    // Rooted at 1-1-0-1: its depth-2 descendants have x in {2,3}, y in
    // {0,1}, z in {2,3}. 2-3-3-2 matches on x (3>>1=1) and z (2>>1=1), but
    // y=3 (3>>1=1) does not match root's y=0 — verified by direct
    // computation, not by hand, since this file has already had one wrong
    // axis claim (a prior version of this test used 2-3-3-3, whose z=3
    // also happens to match and so tests nothing about z).
    expect(() => buildTileTree(URL, page, rootKey)).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    expect(() => buildTileTree(URL, page, rootKey)).toThrow('2-3-3-2');
  });

  it('refuses a subtree violation on the z axis alone', async () => {
    const rootKey = { depth: 1, x: 1, y: 0, z: 1 };
    const page = await hierarchyPageOf([
      { key: [1, 1, 0, 1], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [2, 3, 1, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    // Rooted at 1-1-0-1: 2-3-1-0 matches on x (3>>1=1) and y (1>>1=0), but
    // z=0 (0>>1=0) does not match root's z=1. An isBeneath missing only the
    // z comparison would wrongly accept this key and then recurse forever
    // in `ensure`, since its real ancestor chain (depth 1: 1-1-0-0) never
    // reaches this root's own key (1-1-0-1).
    expect(() => buildTileTree(URL, page, rootKey)).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    expect(() => buildTileTree(URL, page, rootKey)).toThrow('2-3-1-0');
  });

  it('refuses a key whose depth reaches 32, where the shift arithmetic wraps', async () => {
    const rootKey = { depth: 1, x: 1, y: 0, z: 0 };
    const page = await hierarchyPageOf([
      { key: [1, 1, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [33, 1, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    // JS `>>` masks its shift count to 5 bits, so at 32 levels of
    // difference `x >> 32 === x >> 0` (measured: `1 >> 32` is `1`, not
    // `0`). Rooted at 1-1-0-0, 33-1-0-0 is 32 levels down and shares
    // root's x, y, z, so a masked isBeneath falsely accepts it as beneath
    // — its real depth-1 ancestor is 1-0-0-0, not the root — and `ensure`
    // then walks its parent chain past the root, which it never reaches,
    // into negative depths without bound. No COPC octree reaches depth 32,
    // so it is refused outright before isBeneath's arithmetic runs at all.
    expect(() => buildTileTree(URL, page, rootKey)).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    expect(() => buildTileTree(URL, page, rootKey)).toThrow('33-1-0-0');
  });

  it('builds a key at depth 31, the deepest MAX_DEPTH allows', async () => {
    // 2^30: the highest bit a depth-31 key's x may carry. `31-1-0-0` would
    // read the same, but its whole ancestor chain is zero on every axis, so
    // the chain assertion below would hold under any parentOf that returned
    // zeros at this depth — nothing about the arithmetic would be pinned.
    const x = 1_073_741_824;
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [31, x, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    // Pins MAX_DEPTH's accepting side: lower the constant (even to 4, which
    // 31 clears by a wide margin) and this throws instead of building.
    // Paired with the next test, which pins the refusing side at exactly
    // 32, so the constant cannot drift in either direction unnoticed.
    const tree = buildTileTree(URL, page, ROOT);

    expect(tree.synthesizedAncestors).toBe(30);

    // The count alone says only how many tiles were synthesised, not where
    // they were hung. Each ancestor's x is the entry's own x with the levels
    // below it shifted off — arithmetic this test owns, rather than a second
    // call to the builder, which would agree with whatever it did.
    type Node = ReturnType<typeof buildTileTree>['root'];
    const chain: string[] = [];
    for (let node: Node | undefined = tree.root; node !== undefined; node = node.children[0]) {
      chain.push(keyText(node.key));
    }
    expect(chain).toHaveLength(32);
    for (const [depth, text] of chain.entries()) {
      expect(text).toBe(`${depth}-${x >> (31 - depth)}-0-0`);
    }
  });

  it('refuses a key at depth 32, exactly, even where isBeneath would accept it', async () => {
    const page = await hierarchyPageOf([{ key: [32, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 }]);

    // x = y = z = 0 matches ROOT on every axis, and this key genuinely is 32
    // levels beneath it — an honest, unmasked isBeneath would accept it too,
    // so masking isn't why acceptance is possible here. The depth bound is
    // the only thing refusing it, which is why raising MAX_DEPTH to 33
    // (still catching the 33-deep case above, since 33 >= 33) would
    // otherwise leave this file green.
    expect(() => buildTileTree(URL, page, ROOT)).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    expect(() => buildTileTree(URL, page, ROOT)).toThrow('32-0-0-0');
  });

  it('refuses an entry shallower than its own root', async () => {
    const rootKey = { depth: 1, x: 0, y: 0, z: 0 };
    const page = await hierarchyPageOf([{ key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 }]);

    // A sub-page's own root is the shallowest key it can legally hold — it
    // and its descendants are the subtree that page covers, so a shallower
    // entry is corruption, not an incomplete tree. isBeneath's `key.depth <
    // rootKey.depth` guard is what refuses it; without that guard, `levels`
    // goes negative and JS `>>` masks a negative shift count to 5 bits
    // (measured: `0 >> -1 === 0 >> 31 === 0`), so 0-0-0-0 is falsely
    // accepted as beneath 1-0-0-0 on every axis, and `ensure` then walks
    // its parent chain — depth 0, -1, -2, … — forever, since it never
    // reaches a root one level deeper than itself.
    expect(() => buildTileTree(URL, page, rootKey)).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
    expect(() => buildTileTree(URL, page, rootKey)).toThrow('0-0-0-0');
  });

  it('gives an empty page a childless, contentless, synthesised root', async () => {
    const page = await hierarchyPageOf([]);

    // `readHierarchyPage` returns `{ nodes: [], pages: [] }` for a
    // zero-length page (src/copc/hierarchy.ts): nothing named the root, so
    // it is synthesised even though it has no descendant to bridge a gap
    // to — the one case where `synthesized` is true but the tile carries
    // nothing at all.
    const tree = buildTileTree(URL, page, ROOT);

    expect(tree.root.synthesized).toBe(true);
    expect(tree.root.entry).toBeUndefined();
    expect(tree.root.children).toHaveLength(0);
    expect(tree.synthesizedAncestors).toBe(1);
  });

  it('orders children the same way whatever order the page listed them', async () => {
    const forward = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [1, 1, 0, 0], offset: 300, byteSize: 30, pointCount: 7 },
    ]);
    const reversed = await hierarchyPageOf([
      { key: [1, 1, 0, 0], offset: 300, byteSize: 30, pointCount: 7 },
      { key: [1, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
    ]);

    // The emitted JSON is compared byte for byte by later tests and by
    // whoever debugs one; file order must not leak into it.
    const names = (page: Awaited<ReturnType<typeof hierarchyPageOf>>) =>
      buildTileTree(URL, page, ROOT).root.children.map((child) => keyText(child.key));

    expect(names(forward)).toEqual(['1-0-0-0', '1-1-0-0']);
    expect(names(reversed)).toEqual(['1-0-0-0', '1-1-0-0']);
  });

  it('orders children on the y axis, not just x', async () => {
    // These two siblings are identical on x and z (both 0) and differ only
    // on y, so a comparator missing the y term specifically — which a pair
    // differing on both y and z cannot expose, since the z term would still
    // discriminate — would leave Map insertion order to leak through.
    const forward = await hierarchyPageOf([
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 1, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);
    const reversed = await hierarchyPageOf([
      { key: [1, 0, 1, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
    ]);

    const names = (page: Awaited<ReturnType<typeof hierarchyPageOf>>) =>
      buildTileTree(URL, page, ROOT).root.children.map((child) => keyText(child.key));

    expect(names(forward)).toEqual(['1-0-0-0', '1-0-1-0']);
    expect(names(reversed)).toEqual(['1-0-0-0', '1-0-1-0']);
  });

  it('orders children on the z axis, not just x', async () => {
    // Differ only on z, for the same reason the y-only case above needs a
    // pair that isn't also carrying a y difference.
    const forward = await hierarchyPageOf([
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 1], offset: 200, byteSize: 20, pointCount: 6 },
    ]);
    const reversed = await hierarchyPageOf([
      { key: [1, 0, 0, 1], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
    ]);

    const names = (page: Awaited<ReturnType<typeof hierarchyPageOf>>) =>
      buildTileTree(URL, page, ROOT).root.children.map((child) => keyText(child.key));

    expect(names(forward)).toEqual(['1-0-0-0', '1-0-0-1']);
    expect(names(reversed)).toEqual(['1-0-0-0', '1-0-0-1']);
  });

  it('orders a non-root node\'s children too, not just the root\'s', async () => {
    // Every prior ordering test reads `tree.root.children`, so a version of
    // buildTileTree that sorted only that one array — instead of every
    // node's — would satisfy all of them. These two grandchildren share a
    // non-root parent (1-0-0-0) instead.
    const forward = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 50, byteSize: 5, pointCount: 4 },
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [2, 1, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [2, 0, 1, 0], offset: 300, byteSize: 30, pointCount: 7 },
    ]);
    const reversed = await hierarchyPageOf([
      { key: [2, 0, 1, 0], offset: 300, byteSize: 30, pointCount: 7 },
      { key: [2, 1, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [0, 0, 0, 0], offset: 50, byteSize: 5, pointCount: 4 },
    ]);

    const grandchildren = (page: Awaited<ReturnType<typeof hierarchyPageOf>>) =>
      buildTileTree(URL, page, ROOT).root.children[0]?.children.map((child) => keyText(child.key));

    expect(grandchildren(forward)).toEqual(['2-0-1-0', '2-1-0-0']);
    expect(grandchildren(reversed)).toEqual(['2-0-1-0', '2-1-0-0']);
  });
});
