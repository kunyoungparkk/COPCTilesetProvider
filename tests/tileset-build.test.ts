import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Info } from 'copc';
import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { hierarchyPageOf } from './hierarchy-page.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import type { CrsTransform } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { buildTileset } from '../src/tileset/build.js';
import type { TileJson } from '../src/tileset/build.js';
import { buildTileTree, keyText } from '../src/tileset/tree.js';
import type { TileNode } from '../src/tileset/tree.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const DEGREES = 180 / Math.PI;

const autzenCube = () =>
  Info.parse(
    new Uint8Array(
      readFileSync(fileURLToPath(new URL('../fixtures/autzen-head.bin', import.meta.url))),
    ).subarray(429, 429 + 160),
  ).cube;

const contextFor = async (transform: CrsTransform) => ({
  url: 'https://host/constructed.copc.laz',
  tokenBase: 'copc://a1b2c3/',
  cube: autzenCube(),
  rootKey: { depth: 0, x: 0, y: 0, z: 0 },
  rootGeometricError: 88.709_699_234_182_7,
  transform,
});

const transformFor = async (): Promise<CrsTransform> => {
  registerCrs(2992, OREGON);
  return createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));
};

describe('buildTileset', () => {
  it('emits a 3D Tiles document with ADD refinement on the root', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);

    const { json } = buildTileset(page, await contextFor(await transformFor()));

    expect(json.asset).toEqual({ version: '1.0' });
    expect(json.geometricError).toBeCloseTo(88.709_699_234, 9);
    // Decision 6: COPC nodes are a non-overlapping sample, so a volume's full
    // resolution is the union along the path from the root. Set on the root
    // only; 3D Tiles 1.0 inherits it downward.
    expect(json.root.refine).toBe('ADD');
    expect(json.root.children?.[0]?.refine).toBeUndefined();
    expect(json.root.geometricError).toBeCloseTo(88.709_699_234, 9);
    expect(json.root.children?.[0]?.geometricError).toBeCloseTo(44.354_849_617, 9);
  });

  it('names each tile with the caller’s prefix and the octree key', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 0], offset: 900, byteSize: 64, pointCount: -1 },
    ]);

    const { json, entries } = buildTileset(page, await contextFor(await transformFor()));

    expect(json.root.content?.uri).toBe('copc://a1b2c3/n/0-0-0-0');
    expect(json.root.children?.[0]?.content?.uri).toBe('copc://a1b2c3/h/1-0-0-0');
    expect(entries.get('copc://a1b2c3/n/0-0-0-0')).toEqual({
      kind: 'points',
      key: { depth: 0, x: 0, y: 0, z: 0 },
      offset: 100,
      length: 10,
      pointCount: 5,
    });
    expect(entries.get('copc://a1b2c3/h/1-0-0-0')).toEqual({
      kind: 'hierarchy',
      key: { depth: 1, x: 0, y: 0, z: 0 },
      offset: 900,
      length: 64,
    });
  });

  it('gives a zero-point node and a synthesised ancestor no content at all', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 0, byteSize: 0, pointCount: 0 },
      { key: [2, 0, 0, 0], offset: 300, byteSize: 30, pointCount: 7 },
    ]);

    const context = await contextFor(await transformFor());
    const { json, entries, synthesizedAncestors } = buildTileset(page, context);

    // Decision 6 forbids serving a zero-point PNTS by any path: such a tile
    // never reaches ready and tilesLoaded waits forever.
    expect(json.root.content).toBeUndefined();
    expect(json.root.children?.[0]?.content).toBeUndefined();
    expect(synthesizedAncestors).toBe(1);
    expect([...entries.keys()]).toEqual(['copc://a1b2c3/n/2-0-0-0']);

    // The count's definition checked against the tiles rather than restated:
    // the number that carry no content and had no entry of their own. Both
    // contentless tiles here are contentless for different reasons — the
    // root's entry says zero points, 1-0-0-0 had no entry at all — and
    // `entry === undefined` holds for both, which is why `TileNode` carries
    // `synthesized` alongside it.
    const countSynthesized = (tile: TileJson, node: TileNode): number => {
      let total = tile.content === undefined && node.synthesized ? 1 : 0;
      for (const [index, child] of (tile.children ?? []).entries()) {
        const childNode = node.children[index];
        expect(childNode).toBeDefined();
        total += childNode === undefined ? 0 : countSynthesized(child, childNode);
      }
      return total;
    };

    expect(countSynthesized(json.root, buildTileTree(context.url, page, context.rootKey).root)).toBe(
      synthesizedAncestors,
    );
  });

  it('keeps the registry and the document describing the same set of tiles', async () => {
    const page = await hierarchyPageOf([
      { key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [1, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
      { key: [1, 1, 0, 0], offset: 0, byteSize: 0, pointCount: 0 },
      { key: [2, 2, 0, 0], offset: 900, byteSize: 64, pointCount: -1 },
    ]);

    const { json, entries } = buildTileset(page, await contextFor(await transformFor()));

    // If these drift, either a tile is requested that nothing can answer, or a
    // range is held that nothing will ask for.
    const uris: string[] = [];
    const walk = (tile: { content?: { uri: string }; children?: readonly unknown[] }): void => {
      if (tile.content !== undefined) {
        uris.push(tile.content.uri);
      }
      for (const child of tile.children ?? []) {
        walk(child as Parameters<typeof walk>[0]);
      }
    };
    walk(json.root);

    expect(uris.sort()).toEqual([...entries.keys()].sort());
  });

  it('keeps every child region inside its parent, on the real page', async () => {
    const transform = await transformFor();
    const bytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL('../fixtures/autzen-root-hierarchy.bin', import.meta.url))),
    );
    const reader = {
      url: 'https://host/autzen.copc.laz',
      read: () => Promise.resolve({ bytes: bytes.buffer.slice(0), totalBytes: null }),
      readMany: () => Promise.reject(new Error('unused')),
      stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
    };
    const page = await readHierarchyPage(
      reader,
      { offset: 0, length: bytes.byteLength },
      // Above every constructed entry below; this test is not about the bound.
      1_000_000,
    );

    const context = await contextFor(transform);
    const { json, entries, synthesizedAncestors } = buildTileset(page, context);

    // Measured: the pinned page holds 278 nodes over depths 0-5, no sub-pages,
    // no zero-point nodes and no gaps.
    expect(synthesizedAncestors).toBe(0);

    // The child-inside-parent walk below only ever compares a tile's region
    // against its parent's with >= / <=, and equality satisfies both — so it
    // cannot by itself tell "this tile's own region" from "every tile got
    // handed the root's region". entries.size is 278, one per node, all kind
    // 'points' (no sub-pages on this page), confirming there is one registry
    // entry per registered tile before checking what is in them.
    expect(entries.size).toBe(278);

    // A sum over entries.values() is invariant under permutation, so it
    // cannot catch every deep tile registered with a sibling's byte range —
    // still the wrong bytes fetched for every one of them, under Decision 4.
    // Cross-checking against `page` instead pins the mapping, not just the
    // totals: `page` is a different origin than the registry the builder
    // assembled (it comes straight from `readHierarchyPage`, untouched by
    // `buildTileset`), and this also covers `length`, which no sum above
    // ever touched.
    const nodeByKey = new Map(page.nodes.map((node) => [keyText(node.key), node]));
    const pageByKey = new Map(page.pages.map((sub) => [keyText(sub.key), sub]));
    for (const entry of entries.values()) {
      if (entry.kind === 'points') {
        const source = nodeByKey.get(keyText(entry.key));
        expect(source).toBeDefined();
        expect(entry.offset).toBe(source?.offset);
        expect(entry.length).toBe(source?.length);
        expect(entry.pointCount).toBe(source?.pointCount);
      } else {
        const source = pageByKey.get(keyText(entry.key));
        expect(source).toBeDefined();
        expect(entry.offset).toBe(source?.offset);
        expect(entry.length).toBe(source?.length);
      }
    }

    // R1's checks above are all relative to some other tile in the tree, and
    // R2's cross-check resolves an entry by its own `entry.key`, which travels
    // with it if a whole entry (key, offset, length, pointCount together,
    // still self-consistent with some real page node) is swapped onto a
    // different tree position. Nothing so far ties the URI a tile actually
    // carries to the structural position it was reached at. `tree` is a
    // second, independent call to `buildTileTree` — untouched by however
    // `buildTileset` composes entries into `tileFor` — so its `.key` at each
    // position is ground truth to parse the URI's key back against.
    const tree = buildTileTree(context.url, page, context.rootKey);

    const check = (
      tile: {
        boundingVolume: { region: readonly number[] };
        refine?: string;
        content?: { uri: string };
        children?: readonly unknown[];
      },
      node: TileNode,
    ): number => {
      if (tile.content !== undefined) {
        const suffix = tile.content.uri.slice(context.tokenBase.length);
        const match = /^[nh]\/(\d+)-(\d+)-(\d+)-(\d+)$/.exec(suffix);
        expect(match).not.toBeNull();
        const [, depth, x, y, z] = match ?? [];
        expect({ depth: Number(depth), x: Number(x), y: Number(y), z: Number(z) }).toEqual(
          node.key,
        );
      }

      let seen = 1;
      const children = (tile.children ?? []) as Parameters<typeof check>[0][];
      const nodeChildren = node.children;
      for (const [index, child] of children.entries()) {
        for (const boundIndex of [0, 1, 4]) {
          expect(child.boundingVolume.region[boundIndex]).toBeGreaterThanOrEqual(
            tile.boundingVolume.region[boundIndex] ?? 0,
          );
        }
        for (const boundIndex of [2, 3, 5]) {
          expect(child.boundingVolume.region[boundIndex]).toBeLessThanOrEqual(
            tile.boundingVolume.region[boundIndex] ?? 0,
          );
        }
        // The >= / <= pairs above are satisfied by two equal regions, so a
        // build that handed every tile the root's own region (never calling
        // regionForKey with that tile's own key) would pass them undetected.
        expect(child.boundingVolume.region).not.toEqual(tile.boundingVolume.region);
        // 3D Tiles 1.0 inherits refine downward; a non-root tile carrying its
        // own 'ADD' would be redundant but is still worth catching here,
        // since this walk visits every depth, not just the root's children.
        expect(child.refine).toBeUndefined();
        const nodeChild = nodeChildren[index];
        expect(nodeChild).toBeDefined();
        // Everything above is satisfied by a tile hung from its grandparent:
        // a grandparent's cube contains its grandchild's, so the region stays
        // inside and stays distinct, and the URI check compares against the
        // same tree this walk is descending. Under refine ADD the consequence
        // is real — the tile becomes eligible as soon as that shallower
        // ancestor refines, so its points draw with the level beneath them
        // missing. Octree parentage is arithmetic on the key, so it is
        // asserted here rather than read off anything the builder produced.
        expect(nodeChild?.key.depth).toBe(node.key.depth + 1);
        expect((nodeChild?.key.x ?? -1) >> 1).toBe(node.key.x);
        expect((nodeChild?.key.y ?? -1) >> 1).toBe(node.key.y);
        expect((nodeChild?.key.z ?? -1) >> 1).toBe(node.key.z);
        seen += nodeChild === undefined ? 0 : check(child, nodeChild);
      }
      // Still relative, and still blind to a consistently wrong key: a build
      // that keys every tile off (depth, 0, 0, 0) — the min-corner cube at
      // that depth, ignoring x/y/z — keeps every child inside its parent
      // (the min-corner cube nests too) and keeps child != parent (depths
      // differ), so neither check above sees it. Siblings occupy distinct
      // octants at the same depth, so that mutation collapses them all to one
      // identical region; real siblings never coincide.
      for (const [i, a] of children.entries()) {
        for (const [j, b] of children.entries()) {
          if (j > i) {
            expect(b.boundingVolume.region).not.toEqual(a.boundingVolume.region);
          }
        }
      }
      return seen;
    };

    expect(check(json.root, tree.root)).toBe(278);

    // The min-corner and sibling-collapse mutations above are still relative
    // to some other tile in the tree. A key transposed on x/y (Task 5's own
    // trap: swapping axes keeps a cube that nests and keeps it distinct from
    // its neighbours, just in the wrong place) needs one tile's region pinned
    // to a value computed outside this walk. Node 4-2-1-0 is on the pinned
    // page (measured: present in `page.nodes`) with x != y, so a swap changes
    // the answer rather than coincidentally reproducing it.
    const findByUri = (
      tile: { content?: { uri: string }; children?: readonly unknown[] },
      uri: string,
    ): { boundingVolume: { region: readonly number[] } } | undefined => {
      if (tile.content?.uri === uri) {
        return tile as { boundingVolume: { region: readonly number[] } };
      }
      for (const raw of tile.children ?? []) {
        const found = findByUri(raw as Parameters<typeof findByUri>[0], uri);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };

    const pinned = findByUri(json.root, 'copc://a1b2c3/n/4-2-1-0');
    expect(pinned).toBeDefined();
    const region = pinned?.boundingVolume.region;
    // Derived directly from regionForKey(cube, {depth:4,x:2,y:1,z:0}, transform)
    // against this fixture, printed to 15 decimal digits and rounded to 12 —
    // three more than the 9-digit toBeCloseTo checks below, so literal
    // rounding never eats a meaningful share of the 5e-10 tolerance.
    expect((region?.[0] ?? 0) * DEGREES).toBeCloseTo(-123.072_843_346_591, 9);
    expect((region?.[1] ?? 0) * DEGREES).toBeCloseTo(44.050_566_829_219, 9);
    expect((region?.[2] ?? 0) * DEGREES).toBeCloseTo(-123.071_702_268_119, 9);
    expect((region?.[3] ?? 0) * DEGREES).toBeCloseTo(44.051_389_804_437, 9);
    expect(region?.[4] ?? 0).toBeCloseTo(123.791_472, 6);
    expect(region?.[5] ?? 0).toBeCloseTo(212.478_937_5, 6);
  });

  it('uses absolute depth for a sub-page rooted below the file root', async () => {
    const page = await hierarchyPageOf([
      { key: [1, 0, 0, 0], offset: 100, byteSize: 10, pointCount: 5 },
      { key: [2, 0, 0, 0], offset: 200, byteSize: 20, pointCount: 6 },
    ]);
    const context = {
      ...(await contextFor(await transformFor())),
      rootKey: { depth: 1, x: 0, y: 0, z: 0 },
    };

    const { json } = buildTileset(page, context);

    // geometricErrorAtDepth's own contract is the file's absolute depth, not
    // depth counted from this page's own root — "that is what makes a
    // page-pointer tile and the root of the tileset it expands into agree,
    // since they are the same key" (geometric-error.ts). A page rooted below
    // depth 0 is the one case that can tell absolute and page-relative depth
    // apart: both readings agree whenever rootKey.depth is 0, which is every
    // other test in this file.
    expect(json.root.geometricError).toBeCloseTo(44.354_849_617, 9);
    expect(json.root.children?.[0]?.geometricError).toBeCloseTo(22.177_424_8085, 9);
  });
});
