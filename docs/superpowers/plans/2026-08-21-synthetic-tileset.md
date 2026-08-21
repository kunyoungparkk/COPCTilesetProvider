# Synthetic 3D Tiles Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one COPC hierarchy page into a 3D Tiles 1.0 tileset plus the registry that maps each tile's content URI back to the byte range it stands for.

**Architecture:** Four small pure units and a composition. A geometric-error unit measures the file's metre span once at open time; a region unit turns an octree key into a WGS84 `region`; a tree unit turns a page's entries into a parented tile tree, synthesising missing ancestors and refusing malformed ones; `buildTileset` walks that tree and emits the JSON and the registry together. Nothing fetches, nothing touches Cesium.

**Tech Stack:** TypeScript 7 (browser ESM), Vitest, `copc` (`Bounds.stepTo`, `Key`, `Hierarchy.parse`), `proj4` via `src/crs`.

**Spec:** `docs/superpowers/specs/2026-08-21-synthetic-tileset-design.md`

## Global Constraints

- **Node 22 is required.** The default `node` on this machine is v18 and Vitest dies at startup. Prefix every command with `export PATH=/home/kyp/.local/node22/bin:$PATH`.
- **No new dependencies.** OVERVIEW §5 fixes the list at `copc.js`, `laz-perf`, `proj4`. `tests/manifest.test.ts` pins it.
- **Tests never touch the network.** Fixtures under `fixtures/` only.
- **English** for code, comments, commit messages. Commits are `type(scope): summary`, imperative, under 72 characters.
- **`tsc --noEmit` must stay clean.** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `erasableSyntaxOnly` are on: index access yields `T | undefined`, an optional property cannot be assigned `undefined` explicitly, type imports need `import type`, and no parameter properties or enums.
- **Imports use `.js` extensions** even for `.ts` files.
- **§7 values used here:** geometric-error root divisor N = 16; region samples per edge k = 5. Both are §7 rows; changing either means updating that table with a measurement.
- **Every pinned constant carries its derivation** in a comment — which inputs, through which formula. A number nobody can re-derive by hand is not an external reference.

---

### Task 1: `toWgs84` on the CRS transform

`region` wants degrees and metres; `toEcef` already computes both internally and consumes them. This is the only change to `src/crs`.

**Files:**
- Modify: `src/crs/transform.ts`
- Test: `tests/crs-transform.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CrsTransform.toWgs84(x: number, y: number, z: number): [number, number, number]` returning `[longitudeDegrees, latitudeDegrees, heightMetres]`. `toEcef` keeps its signature and meaning.

- [ ] **Step 1: Write the failing tests**

Add to `tests/crs-transform.test.ts`, inside the existing `describe('both halves against the real file', ...)`:

```ts
  it('reports degrees and metres, from the same projection toEcef uses', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    const [longitude, latitude, height] = transform.toWgs84(635_577.79, 848_882.15, 406.14);

    // The file's own header minimum. Longitude and latitude are proj4's, so
    // they are pinned only to the precision the corner test already relies on.
    expect(longitude).toBeCloseTo(-123.074_986_74, 8);
    expect(latitude).toBeCloseTo(44.049_718_82, 8);
    // 406.14 international feet, which is what the height must be converted
    // into: 406.14 * 0.3048 = 123.791472 m exactly.
    expect(height).toBeCloseTo(123.791_472, 9);
  });

  it('agrees with toEcef, which is built on it', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Not a restatement of the implementation: it pins that the two outputs
    // cannot drift apart, which is the whole reason they share one projection
    // rather than being built separately.
    const [longitude, latitude, height] = transform.toWgs84(637_290.76, 851_209.9, 500);

    expect(transform.toEcef(637_290.76, 851_209.9, 500)).toEqual(
      geodeticToEcef(longitude, latitude, height),
    );
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npx vitest run tests/crs-transform.test.ts`
Expected: FAIL — `transform.toWgs84 is not a function`.

- [ ] **Step 3: Implement**

In `src/crs/transform.ts`, replace the `CrsTransform` interface and the returned object.

```ts
export interface CrsTransform {
  /**
   * File coordinates to WGS84 degrees and metres.
   *
   * The height depends only on `z`: proj4 converts the horizontal pair and
   * this module scales the height by the definition's linear unit, so the
   * `x` and `y` passed alongside do not affect it.
   */
  toWgs84(x: number, y: number, z: number): [number, number, number];
  /**
   * File coordinates to ECEF metres. `z` is taken to be in the same linear unit
   * as `x` and `y`, which is a v1 limitation of its own alongside OVERVIEW §6's
   * ellipsoidal heights: a file measuring height in a unit its horizontal
   * system does not use comes out vertically scaled.
   */
  toEcef(x: number, y: number, z: number): [number, number, number];
}
```

and in `createTransformFromDefinition`:

```ts
  const toWgs84Projection = proj4(definition, WGS84);
  const metresPerZ = metresPerUnit(definition);

  // Named rather than inlined into both members: the two outputs must come
  // from one projection, or a caller could place a bounding volume by one
  // rule and its points by another.
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const [longitude, latitude] = toWgs84Projection.forward([x, y]);
    return [longitude, latitude, z * metresPerZ];
  };

  return {
    toWgs84: project,
    toEcef(x, y, z) {
      const [longitude, latitude, height] = project(x, y, z);
      return geodeticToEcef(longitude, latitude, height);
    },
  };
```

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck`
Expected: PASS, 173 tests.

- [ ] **Step 5: Prove the new tests bite**

Change `z * metresPerZ` to `z` in `project`. Run `npm test`. Expected: the height assertion and the `is stable at the corners` test both fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/crs/transform.ts tests/crs-transform.test.ts
git commit -m "feat(crs): report WGS84 degrees and metres alongside ECEF"
```

---

### Task 2: The root geometric error

**Files:**
- Create: `src/tileset/geometric-error.ts`
- Test: `tests/tileset-geometric-error.test.ts`

**Interfaces:**
- Consumes: `CrsTransform.toEcef` (Task 1 leaves it unchanged).
- Produces: `measureRootGeometricError(header: Pick<Las.Header, 'min' | 'max'>, transform: CrsTransform): number` and `geometricErrorAtDepth(rootGeometricError: number, depth: number): number`.

- [ ] **Step 1: Write the failing test**

Create `tests/tileset-geometric-error.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';
import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import {
  geometricErrorAtDepth,
  measureRootGeometricError,
} from '../src/tileset/geometric-error.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const autzenHeader = (): Pick<Las.Header, 'min' | 'max'> => {
  const bytes = new Uint8Array(
    readFileSync(fileURLToPath(new URL('../fixtures/autzen-head.bin', import.meta.url))),
  );
  return Las.Header.parse(bytes.subarray(0, 375));
};

describe('measureRootGeometricError', () => {
  it('divides the largest measured metre span by sixteen', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Derivation, re-runnable by hand from the fixture's own header:
    //   min = [635577.79, 848882.15, 406.14]   max = [639003.73, 853537.66, 615.26]
    //   origin = toEcef(minX, minY, minZ)
    //   xSpan  = |toEcef(maxX, minY, minZ) - origin| = 1044.4878 m
    //   ySpan  = |toEcef(minX, maxY, minZ) - origin| = 1419.3552 m   <- largest
    //   zSpan  = |toEcef(minX, minY, maxZ) - origin| =   63.7398 m
    //   1419.355187746923 / 16 = 88.7096992341827
    // The spans are metres because the transform scales the file's feet; the
    // largest is y, so a bug that took x or z instead moves this by hundreds.
    expect(measureRootGeometricError(autzenHeader(), transform)).toBeCloseTo(88.709_699_234, 9);
  });

  it('takes the vertical span when the data is taller than it is wide', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Decision 6 takes the larger of horizontal and vertical so that a
    // vertically long cloud keeps refining. A 1-foot footprint 10000 feet
    // tall is the case that separates "largest span" from "largest horizontal
    // span" -- the second rule would give 0.019 m here.
    const tall = { min: [635_577.79, 848_882.15, 0], max: [635_578.79, 848_883.15, 10_000] };

    // 10000 ft = 3048 m; 3048 / 16 = 190.5
    expect(measureRootGeometricError(tall as Pick<Las.Header, 'min' | 'max'>, transform))
      .toBeCloseTo(190.5, 6);
  });
});

describe('geometricErrorAtDepth', () => {
  it('halves once per depth', () => {
    expect(geometricErrorAtDepth(88.709_699_234_182_7, 0)).toBeCloseTo(88.709_699_234, 9);
    expect(geometricErrorAtDepth(88.709_699_234_182_7, 1)).toBeCloseTo(44.354_849_617, 9);
    expect(geometricErrorAtDepth(88.709_699_234_182_7, 5)).toBeCloseTo(2.772_178_101, 9);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npx vitest run tests/tileset-geometric-error.test.ts`
Expected: FAIL — cannot resolve `../src/tileset/geometric-error.js`.

- [ ] **Step 3: Implement**

Create `src/tileset/geometric-error.ts`:

```ts
import type { Las } from 'copc';
import type { CrsTransform } from '../crs/index.js';

/**
 * OVERVIEW §7: the root's measured span is divided by this to become the root
 * tile's geometric error. Raising it loads less and looks worse; it is tuned
 * against `maximumScreenSpaceError`, not on its own.
 */
const ROOT_DIVISOR = 16;

const metresApart = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The root tile's geometric error, in metres.
 *
 * Decision 6 asks for the *measured* metre span of the file, the larger of
 * horizontal and vertical, divided by §7's constant. Two things follow. The
 * span is the header's extent rather than `info.cube`, which is padded into a
 * cube and reaches far above the data. And the file's units need not be metres
 * — the pinned fixture's are feet — so the span is measured by transforming
 * corner pairs and taking ECEF distances rather than by exposing a unit scale
 * that would be a second way to get the conversion wrong.
 *
 * The three distances are chords rather than geodesics. Over a file's own
 * extent the difference is far below the metre this value is quantised into by
 * the division.
 */
export function measureRootGeometricError(
  header: Pick<Las.Header, 'min' | 'max'>,
  transform: CrsTransform,
): number {
  const [minX, minY, minZ] = header.min;
  const [maxX, maxY, maxZ] = header.max;

  const origin = transform.toEcef(minX, minY, minZ);
  const span = Math.max(
    metresApart(transform.toEcef(maxX, minY, minZ), origin),
    metresApart(transform.toEcef(minX, maxY, minZ), origin),
    metresApart(transform.toEcef(minX, minY, maxZ), origin),
  );

  return span / ROOT_DIVISOR;
}

/**
 * A tile's geometric error: the root's, halved once per octree level.
 *
 * The depth is the key's absolute depth in the file, never its depth within
 * the page being built. That is what makes a page-pointer tile and the root of
 * the tileset it expands into agree, since they are the same key.
 */
export function geometricErrorAtDepth(rootGeometricError: number, depth: number): number {
  return rootGeometricError / 2 ** depth;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck`
Expected: PASS, 176 tests.

- [ ] **Step 5: Prove the tests bite**

Three mutations, each run with `npm test`, each restored afterwards:
1. `Math.max` → `Math.min` in `measureRootGeometricError`. Expected: the Autzen pin fails (63.74/16 = 3.98, not 88.71).
2. Drop the third `metresApart` (the z span). Expected: the tall-data test fails.
3. `2 ** depth` → `2 * depth`. Expected: the depth-0 assertion fails first — `2 * 0` is zero, so the division yields `Infinity` — which aborts the `it` before the later expects run. The three depths are still asserted together because they pin the halving rule rather than any one value, but the mutation is caught at depth 0, not at depth 5.

- [ ] **Step 6: Commit**

```bash
git add src/tileset/geometric-error.ts tests/tileset-geometric-error.test.ts
git commit -m "feat(tileset): measure the root geometric error in metres"
```

---

### Task 3: Hand-built hierarchy pages, cross-checked against copc.js

The pinned fixture is a single page of 278 nodes with no sub-pages, no zero-point nodes and no gaps. Four of this module's branches — page pointers, empty nodes, synthesised ancestors, and the two refusals — therefore have no real input in this repo, and need constructed ones.

A constructed page is only worth testing against if it is really a COPC page. So the encoder writes the 32-byte entry layout the specification defines, and a test proves `copc.js` reads back what was written — including that `pointCount` −1 lands among *pages* rather than *nodes*. Without that cross-check the later tests would only prove we can parse bytes we invented.

**Files:**
- Create: `tests/hierarchy-page.ts` (helper, not a test file — `vitest.config.ts` includes only `tests/**/*.test.ts`)
- Test: `tests/hierarchy-page.test.ts`

**Interfaces:**
- Consumes: `readHierarchyPage` from `src/copc/hierarchy.js`.
- Produces:
  - `encodeHierarchyPage(entries: readonly PageEntryBytes[]): Uint8Array`
  - `hierarchyPageOf(entries: readonly PageEntryBytes[]): Promise<HierarchyPage>`
  - `interface PageEntryBytes { key: readonly [number, number, number, number]; offset: number; byteSize: number; pointCount: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/hierarchy-page.test.ts`:

```ts
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
    ]);

    // 32 bytes per entry is the specification's own figure, and copc.js
    // rejects any page whose length is not a multiple of it.
    expect(bytes.byteLength).toBe(96);

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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npx vitest run tests/hierarchy-page.test.ts`
Expected: FAIL — cannot resolve `./hierarchy-page.js`.

- [ ] **Step 3: Implement the helper**

Create `tests/hierarchy-page.ts`:

```ts
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
 * gaps, so four of the builder's branches have no real page to be tested
 * against. `tests/hierarchy-page.test.ts` checks copc.js reads back what this
 * writes, so a constructed page is evidence rather than a private convention.
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

/** The same bytes, read through the library's own reader rather than around it. */
export function hierarchyPageOf(entries: readonly PageEntryBytes[]): Promise<HierarchyPage> {
  const bytes = encodeHierarchyPage(entries);
  const reader = {
    url: 'https://host/constructed.copc.laz',
    read: () => Promise.resolve({ bytes: bytes.buffer.slice(0), totalBytes: null }),
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck`
Expected: PASS, 178 tests.

- [ ] **Step 5: Prove the cross-check bites**

Change `view.setInt32(at + 28, entry.pointCount, true)` to write at `at + 24`. Run `npx vitest run tests/hierarchy-page.test.ts`. Expected: FAIL — copc.js no longer finds the page entry. Restore.

- [ ] **Step 6: Commit**

```bash
git add tests/hierarchy-page.ts tests/hierarchy-page.test.ts
git commit -m "test: build hierarchy pages the parser agrees are pages"
```

---

### Task 4: A node's WGS84 region

**Files:**
- Create: `src/tileset/region.ts`
- Test: `tests/tileset-region.test.ts`

**Interfaces:**
- Consumes: `CrsTransform.toWgs84` (Task 1); `Bounds.stepTo` from `copc`.
- Produces: `regionForKey(cube: Bounds, key: NodeKey, transform: CrsTransform): Region`, where `type Region = readonly [west: number, south: number, east: number, north: number, minimumHeight: number, maximumHeight: number]` — angles in radians, heights in metres.

- [ ] **Step 1: Write the failing test**

Create `tests/tileset-region.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Info, Las } from 'copc';
import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import type { CrsTransform } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { regionForKey } from '../src/tileset/region.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const DEGREES = 180 / Math.PI;

const head = (): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL('../fixtures/autzen-head.bin', import.meta.url))),
  );

// The info VLR sits at 375 + 54: the 375-byte LAS 1.4 header, then the 54-byte
// VLR header in front of its 160-byte payload. Decision 4's first read covers
// all of it, which is why one fixture holds both.
const autzenInfo = () => Info.parse(head().subarray(429, 429 + 160));
const autzenHeader = () => Las.Header.parse(head().subarray(0, 375));

const transformFor = async (): Promise<CrsTransform> => {
  registerCrs(2992, OREGON);
  return createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));
};

describe('regionForKey on the real file', () => {
  it('places the root cube where the file says it is', async () => {
    const region = regionForKey(autzenInfo().cube, { depth: 0, x: 0, y: 0, z: 0 }, await transformFor());
    const [west, south, east, north, minimumHeight, maximumHeight] = region;

    // Derivation: info.cube = [635577.79, 848882.15, 406.14, 640233.30,
    // 853537.66, 5061.65] in EPSG:2992 feet. Its XY perimeter is sampled at
    // k = 5 per edge and projected; the extremes below are those samples,
    // widened by the curvature measured on each edge (2.99e-8 deg of
    // longitude, 3.44e-7 deg of latitude).
    expect(west * DEGREES).toBeCloseTo(-123.075_542_258, 9);
    expect(south * DEGREES).toBeCloseTo(44.049_718_474, 9);
    expect(east * DEGREES).toBeCloseTo(-123.057_284_529, 9);
    expect(north * DEGREES).toBeCloseTo(44.062_885_832, 9);
    // Heights are the cube's own z, in metres: 406.14 ft * 0.3048 = 123.791472,
    // 5061.65 ft * 0.3048 = 1542.790920.
    expect(minimumHeight).toBeCloseTo(123.791_472, 6);
    expect(maximumHeight).toBeCloseTo(1542.790_920, 6);
  });

  it('contains the header corners, which it never saw', async () => {
    const transform = await transformFor();
    const [west, south, east, north] = regionForKey(
      autzenInfo().cube,
      { depth: 0, x: 0, y: 0, z: 0 },
      transform,
    );
    const { min, max } = autzenHeader();

    // The independent path: the region is built from info.cube by stepping and
    // sampling, and this checks it against the header, projected directly.
    // The two share no intermediate. Note the cube's west and south edges are
    // the header's own -- COPC pads the cube east and north -- so on those two
    // sides the only margin is the curvature padding, and a padding of zero
    // fails this test.
    for (const [x, y] of [[min[0], min[1]], [max[0], min[1]], [min[0], max[1]], [max[0], max[1]]]) {
      const [longitude, latitude] = transform.toWgs84(x ?? 0, y ?? 0, 0);
      expect(longitude).toBeGreaterThanOrEqual(west * DEGREES);
      expect(longitude).toBeLessThanOrEqual(east * DEGREES);
      expect(latitude).toBeGreaterThanOrEqual(south * DEGREES);
      expect(latitude).toBeLessThanOrEqual(north * DEGREES);
    }
  });

  it('keeps a child inside its parent', async () => {
    const cube = autzenInfo().cube;
    const transform = await transformFor();
    const parent = regionForKey(cube, { depth: 0, x: 0, y: 0, z: 0 }, transform);

    // Every child of the root, so the test cannot pass by picking a lucky one.
    for (let index = 0; index < 8; index++) {
      const child = regionForKey(
        cube,
        { depth: 1, x: index & 1, y: (index >> 1) & 1, z: (index >> 2) & 1 },
        transform,
      );

      expect(child[0]).toBeGreaterThanOrEqual(parent[0]);
      expect(child[1]).toBeGreaterThanOrEqual(parent[1]);
      expect(child[2]).toBeLessThanOrEqual(parent[2]);
      expect(child[3]).toBeLessThanOrEqual(parent[3]);
      expect(child[4]).toBeGreaterThanOrEqual(parent[4]);
      expect(child[5]).toBeLessThanOrEqual(parent[5]);
    }
  });

  it('is wider than its corners alone would be', async () => {
    // Decision 6 samples the edges because a projection is nonlinear, so an
    // edge's extreme can fall between its endpoints. On a conformal conic over
    // one kilometre the effect is small -- 0.038 m on this cube's south edge --
    // which is exactly why an assertion is needed: nothing else would notice
    // sampling being reduced to the four corners.
    const cube = autzenInfo().cube;
    const region = regionForKey(cube, { depth: 0, x: 0, y: 0, z: 0 }, await transformFor());
    const transform = await transformFor();

    const [cornerLongitude, cornerLatitude] = transform.toWgs84(cube[0], cube[1], 0);

    expect(region[0] * DEGREES).toBeLessThan(cornerLongitude);
    expect(region[1] * DEGREES).toBeLessThan(cornerLatitude);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npx vitest run tests/tileset-region.test.ts`
Expected: FAIL — cannot resolve `../src/tileset/region.js`.

- [ ] **Step 3: Implement**

Create `src/tileset/region.ts`:

```ts
import { Bounds } from 'copc';
import type { NodeKey } from '../copc/index.js';
import type { CrsTransform } from '../crs/index.js';

/**
 * OVERVIEW §7: samples taken along each edge of a node's cube, corners
 * included. Raising it narrows the measured curvature padding at the cost of
 * four more projections per step; it is a cost-versus-slack knob rather than
 * an accuracy one, because the padding is measured either way.
 */
const SAMPLES_PER_EDGE = 5;

const RADIANS_PER_DEGREE = Math.PI / 180;

/** A 3D Tiles `region`: angles in radians, heights in metres, WGS84. */
export type Region = readonly [
  west: number,
  south: number,
  east: number,
  north: number,
  minimumHeight: number,
  maximumHeight: number,
];

/**
 * The bounding volume of the octree node a key addresses.
 *
 * Decision 6 chose `region` to avoid computing ECEF box geometry, and requires
 * the volume to contain its tile's data completely. Corners alone would not:
 * a projection is nonlinear, so an edge's extreme can lie between its ends.
 * The perimeter is therefore sampled, and — because sampling on its own is not
 * conservative either — the resulting box is widened by the curvature actually
 * measured on that node's own edges, comparing each sample against the
 * straight line between that edge's projected endpoints.
 *
 * What that does not promise: a curve that leaves the box between two adjacent
 * samples is still missed. The residual shrinks with `SAMPLES_PER_EDGE`, and
 * the honest statement is that the region is conservative to the resolution
 * sampled.
 *
 * The cube comes from copc.js's own `Bounds.stepTo`, which is the subdivision
 * the file used, so there is no second implementation to disagree with it.
 */
export function regionForKey(cube: Bounds, key: NodeKey, transform: CrsTransform): Region {
  const [minX, minY, minZ, maxX, maxY, maxZ] = Bounds.stepTo(cube, [
    key.depth,
    key.x,
    key.y,
    key.z,
  ]);

  const edges = [
    [[minX, minY], [maxX, minY]],
    [[maxX, minY], [maxX, maxY]],
    [[maxX, maxY], [minX, maxY]],
    [[minX, maxY], [minX, minY]],
  ] as const;

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let longitudePadding = 0;
  let latitudePadding = 0;

  for (const [from, to] of edges) {
    const [fromLongitude, fromLatitude] = transform.toWgs84(from[0], from[1], 0);
    const [toLongitude, toLatitude] = transform.toWgs84(to[0], to[1], 0);

    for (let sample = 0; sample < SAMPLES_PER_EDGE; sample++) {
      const along = sample / (SAMPLES_PER_EDGE - 1);
      const [longitude, latitude] = transform.toWgs84(
        from[0] + (to[0] - from[0]) * along,
        from[1] + (to[1] - from[1]) * along,
        0,
      );

      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);

      // How far this sample sits off the straight line between the edge's own
      // projected ends — the curvature the box has to make room for.
      longitudePadding = Math.max(
        longitudePadding,
        Math.abs(longitude - (fromLongitude + (toLongitude - fromLongitude) * along)),
      );
      latitudePadding = Math.max(
        latitudePadding,
        Math.abs(latitude - (fromLatitude + (toLatitude - fromLatitude) * along)),
      );
    }
  }

  // Heights depend only on z: the transform scales it by the definition's
  // linear unit and leaves the horizontal pair to proj4, so the cube's own
  // corner is used rather than coordinates invented for the call.
  const [, , minimumHeight] = transform.toWgs84(minX, minY, minZ);
  const [, , maximumHeight] = transform.toWgs84(minX, minY, maxZ);

  return [
    (west - longitudePadding) * RADIANS_PER_DEGREE,
    (south - latitudePadding) * RADIANS_PER_DEGREE,
    (east + longitudePadding) * RADIANS_PER_DEGREE,
    (north + latitudePadding) * RADIANS_PER_DEGREE,
    minimumHeight,
    maximumHeight,
  ];
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck`
Expected: PASS, 182 tests.

- [ ] **Step 5: Prove the tests bite**

Four mutations, each restored afterwards:
1. `SAMPLES_PER_EDGE` 5 → 2 (corners only). Expected: `is wider than its corners alone would be` fails, because the padding collapses to zero.
2. Drop both paddings (return the raw sampled box). Expected: `contains the header corners` fails on the west or south side.
3. Swap `minimumHeight` and `maximumHeight`. Expected: the root pin fails.
4. Return degrees instead of radians. Expected: every angular assertion fails.

- [ ] **Step 6: Commit**

```bash
git add src/tileset/region.ts tests/tileset-region.test.ts
git commit -m "feat(tileset): bound a node with a measured WGS84 region"
```

---

### Task 5: The tile tree

Turns a page's entries into a parented tree: refusing a malformed page, completing an incomplete one, and counting what it completed.

One thing to know before writing the duplicate check: `copc.js`'s `Hierarchy.parse` stores nodes and pages in objects keyed by the key string, so two entries with the same key *and the same kind* collapse before we ever see them. The overlap that can reach us is a key present as a node **and** as a page pointer, which lands in both maps.

**Files:**
- Create: `src/tileset/tree.ts`
- Test: `tests/tileset-tree.test.ts`

**Interfaces:**
- Consumes: `HierarchyPage`, `NodeKey` from `src/copc/index.js`; `MalformedHierarchyError` from `src/errors/index.js`; `hierarchyPageOf` (Task 3) in tests.
- Produces:
  - `type TileEntry = { kind: 'points'; key: NodeKey; offset: number; length: number; pointCount: number } | { kind: 'hierarchy'; key: NodeKey; offset: number; length: number }`
  - `interface TileNode { key: NodeKey; entry: TileEntry | undefined; synthesized: boolean; children: readonly TileNode[] }`
  - `interface TileTree { root: TileNode; synthesizedAncestors: number }`
  - `buildTileTree(url: string, page: HierarchyPage, rootKey: NodeKey): TileTree`
  - `keyText(key: NodeKey): string`

- [ ] **Step 1: Write the failing test**

Create `tests/tileset-tree.test.ts`:

```ts
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

    // Rooted at 1-0-0-0, whose descendants at depth 2 are 2-0-0-0 and
    // 2-1-0-0. 2-2-0-0 belongs to 1-1-0-0's page.
    expect(() => buildTileTree(URL, page, { depth: 1, x: 0, y: 0, z: 0 })).toThrow(
      expect.objectContaining({ code: 'malformed-hierarchy' }),
    );
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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npx vitest run tests/tileset-tree.test.ts`
Expected: FAIL — cannot resolve `../src/tileset/tree.js`.

- [ ] **Step 3: Implement**

Create `src/tileset/tree.ts`:

```ts
import type { HierarchyPage, NodeKey } from '../copc/index.js';
import { MalformedHierarchyError } from '../errors/index.js';

/** What a tile's content URI stands for. Both shapes are assignable to `ByteRange`. */
export type TileEntry =
  | {
      readonly kind: 'points';
      readonly key: NodeKey;
      readonly offset: number;
      readonly length: number;
      readonly pointCount: number;
    }
  | {
      readonly kind: 'hierarchy';
      readonly key: NodeKey;
      readonly offset: number;
      readonly length: number;
    };

export interface TileNode {
  readonly key: NodeKey;
  /** Absent for a zero-point node and for a synthesised ancestor. */
  readonly entry: TileEntry | undefined;
  /** True when the page named no entry for this key and the tile exists to carry descendants. */
  readonly synthesized: boolean;
  readonly children: readonly TileNode[];
}

export interface TileTree {
  readonly root: TileNode;
  /**
   * The number of ancestor tiles this call synthesised.
   *
   * Tiles, not files, and not gaps: one gap spanning several levels produces
   * one tile per level. Equal to the number of nodes with `synthesized` set.
   */
  readonly synthesizedAncestors: number;
}

/** An octree key in the `depth-x-y-z` form COPC writes and our URIs carry. */
export function keyText(key: NodeKey): string {
  return `${key.depth}-${key.x}-${key.y}-${key.z}`;
}

const parentOf = (key: NodeKey): NodeKey => ({
  depth: key.depth - 1,
  x: key.x >> 1,
  y: key.y >> 1,
  z: key.z >> 1,
});

/** Whether `key` is `rootKey` or sits beneath it. */
function isBeneath(key: NodeKey, rootKey: NodeKey): boolean {
  if (key.depth < rootKey.depth) {
    return false;
  }
  const levels = key.depth - rootKey.depth;
  return (
    key.x >> levels === rootKey.x && key.y >> levels === rootKey.y && key.z >> levels === rootKey.z
  );
}

const byKey = (a: TileNode, b: TileNode): number =>
  a.key.depth - b.key.depth || a.key.x - b.key.x || a.key.y - b.key.y || a.key.z - b.key.z;

interface MutableTileNode {
  readonly key: NodeKey;
  readonly entry: TileEntry | undefined;
  readonly synthesized: boolean;
  readonly children: MutableTileNode[];
}

/**
 * Arranges a page's entries into the tile tree the tileset is emitted from.
 *
 * The boundary Decision 6 draws, and the reason this function throws in some
 * places and repairs in others: **a format violation is still a
 * `MalformedHierarchyError`; synthesis applies only to a valid but incomplete
 * tree.** A key that is both a node and a page pointer, and an entry from
 * outside this page's subtree, are violations — the first has two entries
 * disagreeing about where data lives, the second would place a node under an
 * ancestor that is not its own. A missing ancestor is neither: nothing in the
 * specification requires every ancestor to carry an entry, and a key alone
 * determines its cube, so the tile is rebuilt exactly rather than guessed at.
 *
 * Children are sorted so that the emitted JSON does not depend on the order
 * the file happened to list entries in.
 */
export function buildTileTree(url: string, page: HierarchyPage, rootKey: NodeKey): TileTree {
  const rootText = keyText(rootKey);
  const entries = new Map<string, TileEntry | undefined>();

  const claim = (key: NodeKey, entry: TileEntry | undefined): void => {
    const text = keyText(key);
    if (!isBeneath(key, rootKey)) {
      throw new MalformedHierarchyError(
        url,
        `its entry ${JSON.stringify(text)} is not inside the page rooted at ${JSON.stringify(rootText)}`,
      );
    }
    if (entries.has(text)) {
      throw new MalformedHierarchyError(
        url,
        `its entry ${JSON.stringify(text)} is both a node and a hierarchy page`,
      );
    }
    entries.set(text, entry);
  };

  for (const node of page.nodes) {
    // Decision 6: a zero-point node keeps its tile and loses its content. The
    // specification gives it offset 0 and byteSize 0, so there is nothing to
    // register even if we wanted to.
    claim(
      node.key,
      node.pointCount === 0
        ? undefined
        : {
            kind: 'points',
            key: node.key,
            offset: node.offset,
            length: node.length,
            pointCount: node.pointCount,
          },
    );
  }
  for (const sub of page.pages) {
    claim(sub.key, { kind: 'hierarchy', key: sub.key, offset: sub.offset, length: sub.length });
  }

  const nodes = new Map<string, MutableTileNode>();
  let synthesizedAncestors = 0;

  const ensure = (key: NodeKey): MutableTileNode => {
    const text = keyText(key);
    const existing = nodes.get(text);
    if (existing !== undefined) {
      return existing;
    }

    const named = entries.has(text);
    const created: MutableTileNode = {
      key,
      entry: entries.get(text),
      synthesized: !named,
      children: [],
    };
    if (!named) {
      synthesizedAncestors += 1;
    }
    nodes.set(text, created);

    if (text !== rootText) {
      ensure(parentOf(key)).children.push(created);
    }
    return created;
  };

  const root = ensure(rootKey);
  for (const text of entries.keys()) {
    const [depth, x, y, z] = text.split('-').map(Number);
    ensure({ depth: depth ?? 0, x: x ?? 0, y: y ?? 0, z: z ?? 0 });
  }

  for (const node of nodes.values()) {
    node.children.sort(byKey);
  }

  return { root, synthesizedAncestors };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck`
Expected: PASS, seven tests more than the previous task left. (Absolute counts in this plan drift: fix rounds add tests, and by Task 5 the suite was at 192 rather than the 189 planned.)

- [ ] **Step 5: Prove the tests bite**

Five mutations, each restored:
1. Delete the `entries.has(text)` duplicate guard. Expected: the node/page-pointer test fails.
2. Delete the `isBeneath` guard. Expected: the outside-subtree test fails (with a stack overflow, which is itself the argument for the guard).
3. Make `ensure` count a named key as synthesised. Expected: two or three tests fail — the zero-point test, and any other asserting `synthesizedAncestors` is 0. Both readings of the mutation (always increment, or invert the `named` condition) were measured to redden more than the one test this step originally named.
4. `synthesizedAncestors += 1` → set to 1. Expected: the two-level gap test fails, which is the definition being pinned.
5. Delete `node.children.sort(byKey)`. Expected: the ordering test fails on the reversed page.

- [ ] **Step 6: Commit**

```bash
git add src/tileset/tree.ts tests/tileset-tree.test.ts
git commit -m "feat(tileset): arrange a page into a parented tile tree"
```

---

### Task 6: `buildTileset`

**Files:**
- Create: `src/tileset/build.ts`
- Test: `tests/tileset-build.test.ts`

**Interfaces:**
- Consumes: `buildTileTree`, `keyText`, `TileEntry`, `TileNode` (Task 5); `regionForKey` (Task 4); `geometricErrorAtDepth` (Task 2).
- Produces: `buildTileset(page: HierarchyPage, context: TilesetContext): SyntheticTileset`, with `TilesetContext { url, tokenBase, cube, rootKey, rootGeometricError, transform }` and `SyntheticTileset { json, entries, synthesizedAncestors }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tileset-build.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Info } from 'copc';
import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { hierarchyPageOf } from './hierarchy-page.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import type { CrsTransform } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { buildTileset } from '../src/tileset/build.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

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

    const { json, entries, synthesizedAncestors } = buildTileset(
      page,
      await contextFor(await transformFor()),
    );

    // Decision 6 forbids serving a zero-point PNTS by any path: such a tile
    // never reaches ready and tilesLoaded waits forever.
    expect(json.root.content).toBeUndefined();
    expect(json.root.children?.[0]?.content).toBeUndefined();
    expect(synthesizedAncestors).toBe(1);
    expect([...entries.keys()]).toEqual(['copc://a1b2c3/n/2-0-0-0']);
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
    const walk = (tile: { content?: { uri: string }; children?: unknown[] }): void => {
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
    const { readHierarchyPage } = await import('../src/copc/hierarchy.js');
    const page = await readHierarchyPage(reader, { offset: 0, length: bytes.byteLength });

    const { json, synthesizedAncestors } = buildTileset(page, await contextFor(transform));

    // Measured: the pinned page holds 278 nodes over depths 0-5, no sub-pages,
    // no zero-point nodes and no gaps.
    expect(synthesizedAncestors).toBe(0);

    const check = (tile: {
      boundingVolume: { region: readonly number[] };
      children?: unknown[];
    }): number => {
      let seen = 1;
      for (const raw of tile.children ?? []) {
        const child = raw as Parameters<typeof check>[0];
        for (const index of [0, 1, 4]) {
          expect(child.boundingVolume.region[index]).toBeGreaterThanOrEqual(
            tile.boundingVolume.region[index] ?? 0,
          );
        }
        for (const index of [2, 3, 5]) {
          expect(child.boundingVolume.region[index]).toBeLessThanOrEqual(
            tile.boundingVolume.region[index] ?? 0,
          );
        }
        seen += check(child);
      }
      return seen;
    };

    expect(check(json.root)).toBe(278);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npx vitest run tests/tileset-build.test.ts`
Expected: FAIL — cannot resolve `../src/tileset/build.js`.

- [ ] **Step 3: Implement**

Create `src/tileset/build.ts`:

```ts
import type { Bounds } from 'copc';
import type { HierarchyPage, NodeKey } from '../copc/index.js';
import type { CrsTransform } from '../crs/index.js';
import { geometricErrorAtDepth } from './geometric-error.js';
import type { Region } from './region.js';
import { regionForKey } from './region.js';
import type { TileEntry, TileNode } from './tree.js';
import { buildTileTree, keyText } from './tree.js';

/** The subset of a 3D Tiles 1.0 document this module emits. */
export interface TilesetJson {
  readonly asset: { readonly version: '1.0' };
  readonly geometricError: number;
  readonly root: TileJson;
}

export interface TileJson {
  readonly boundingVolume: { readonly region: Region };
  readonly geometricError: number;
  readonly refine?: 'ADD';
  readonly content?: { readonly uri: string };
  readonly children?: readonly TileJson[];
}

export interface TilesetContext {
  /** The file being described. Errors name it, as everywhere else in the library. */
  readonly url: string;
  /**
   * Absolute URI prefix every tile's content URI is built on.
   *
   * The caller owns the scheme because the caller owns the interception.
   * Contract: absolute — a scheme is required, since Decision 2's first
   * constraint is that relative resolution against a Blob URL does not work —
   * ending with `/`, containing only characters that survive URI
   * normalisation unescaped, stable for the life of the provider because the
   * registry's keys are built from it, and unique per provider so two
   * tilesets on one globe cannot collide.
   */
  readonly tokenBase: string;
  /** `info.cube` — the octree root every node's cube is stepped from. */
  readonly cube: Bounds;
  /** The key this page is rooted at. `0-0-0-0` for the file's root page. */
  readonly rootKey: NodeKey;
  /** The whole file's root geometric error, from `measureRootGeometricError`. */
  readonly rootGeometricError: number;
  readonly transform: CrsTransform;
}

export interface SyntheticTileset {
  readonly json: TilesetJson;
  /** Keyed by full content URI, which is what the interceptor is handed. */
  readonly entries: ReadonlyMap<string, TileEntry>;
  /** See `TileTree.synthesizedAncestors`: ancestor tiles, not files or gaps. */
  readonly synthesizedAncestors: number;
}

const uriFor = (tokenBase: string, entry: TileEntry): string =>
  `${tokenBase}${entry.kind === 'points' ? 'n' : 'h'}/${keyText(entry.key)}`;

/**
 * Turns one hierarchy page into a tileset and the registry that resolves it.
 *
 * The same function serves the file's root page and every sub-page: Decision
 * 2's second constraint, that a hierarchy tile expands into an external
 * tileset, is met by calling this again rather than by a second code path.
 *
 * Pure and synchronous. Blob URLs, codec installation and the `Resource`
 * interception that consumes these URIs belong to the provider.
 */
export function buildTileset(page: HierarchyPage, context: TilesetContext): SyntheticTileset {
  const tree = buildTileTree(context.url, page, context.rootKey);
  const entries = new Map<string, TileEntry>();

  const tileFor = (node: TileNode, isRoot: boolean): TileJson => {
    const children = node.children.map((child) => tileFor(child, false));

    let content: { readonly uri: string } | undefined;
    if (node.entry !== undefined) {
      const uri = uriFor(context.tokenBase, node.entry);
      entries.set(uri, node.entry);
      content = { uri };
    }

    // Assembled with conditional spreads rather than by assigning `undefined`:
    // `exactOptionalPropertyTypes` distinguishes an absent property from one
    // present and undefined, and 3D Tiles readers do too. If the spread union
    // will not narrow to `TileJson`, widen the local to `TileJson` with an
    // explicit annotation rather than reaching for `as` — the same pattern
    // `src/range/range-reader.ts` uses for its optional request fields.
    return {
      boundingVolume: { region: regionForKey(context.cube, node.key, context.transform) },
      geometricError: geometricErrorAtDepth(context.rootGeometricError, node.key.depth),
      ...(isRoot ? { refine: 'ADD' as const } : {}),
      ...(content === undefined ? {} : { content }),
      ...(children.length === 0 ? {} : { children }),
    };
  };

  const root = tileFor(tree.root, true);

  return {
    json: { asset: { version: '1.0' }, geometricError: root.geometricError, root },
    entries,
    synthesizedAncestors: tree.synthesizedAncestors,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck`
Expected: PASS, five tests more than the previous task left.

- [ ] **Step 5: Prove the tests bite**

Four mutations, each restored:
1. Register an entry for a node whose `entry` is undefined (emit a zero-point URI). Expected: the zero-point test and the registry-matches-document test fail.
2. Put `refine: 'ADD'` on every tile. Expected: the inheritance assertion fails.
3. Use the page-relative depth instead of `node.key.depth`. Expected: the depth-1 geometric error assertion fails.
4. Swap `'n'` and `'h'` in `uriFor`. Expected: both URI assertions fail.

- [ ] **Step 6: Commit**

```bash
git add src/tileset/build.ts tests/tileset-build.test.ts
git commit -m "feat(tileset): emit the document and its registry together"
```

---

### Task 7: The barrel

**Files:**
- Create: `src/tileset/index.ts`
- Modify: `src/tileset/README.md`

**Interfaces:**
- Produces: the module's public surface — `buildTileset`, `measureRootGeometricError`, and the types a caller names.

- [ ] **Step 1: Write the barrel**

Create `src/tileset/index.ts`:

```ts
export type { SyntheticTileset, TileJson, TilesetContext, TilesetJson } from './build.js';
export { buildTileset } from './build.js';
export { measureRootGeometricError } from './geometric-error.js';
export type { Region } from './region.js';
export type { TileEntry } from './tree.js';
```

`geometricErrorAtDepth`, `regionForKey`, `buildTileTree` and `keyText` stay internal: nothing outside this module computes a tile's error, bounds a key, or arranges a page.

- [ ] **Step 2: Update the module README**

Replace `src/tileset/README.md` with:

```markdown
# tileset

Maps the COPC octree onto a synthetic 3D Tiles document, plus the opaque-token registry that resolves each tile back to its byte range.

`buildTileset` serves the file's root page and every sub-page alike, so a hierarchy tile expanding into an external tileset is another call rather than another code path. It is pure and synchronous: Blob URLs, codec installation and `Resource` interception belong to the provider, and the URI scheme is the caller's because the caller owns the interception.

Two limits worth knowing. A node's region is conservative to the resolution sampled — the perimeter is sampled per edge and then widened by the curvature measured on that edge, so a projection that leaves the box between two adjacent samples is still missed. And a page whose entries skip a level gets skeleton tiles, counted in `synthesizedAncestors`; a page that contradicts itself is refused instead.

OVERVIEW §3, Decisions 1, 2 and 6.
```

- [ ] **Step 3: Verify the whole suite and the typecheck**

Run: `export PATH=/home/kyp/.local/node22/bin:$PATH && npm test && npm run typecheck && npx vitest run --no-isolate && npx vitest run --no-isolate --fileParallelism=false`
Expected: PASS in all three isolation modes with no new tests, `tsc` exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/tileset/index.ts src/tileset/README.md
git commit -m "feat(tileset): expose the builder and its types"
```

---

## Done when

- `buildTileset` turns the pinned Autzen page into a 278-tile document whose every child region sits inside its parent's.
- The root geometric error is 88.7097 m, derived from the header's own corners and re-derivable by hand from the comment that carries it.
- The root region contains the header's four corners, reached by a path that shares no intermediate with the builder.
- Page pointers, zero-point nodes, synthesised ancestors and both refusals each have a test on a constructed page that `copc.js` agrees is a page.
- `synthesizedAncestors` counts tiles, pinned by a gap that spans two levels.
- The registry's keys are exactly the content URIs in the document.
- `tsc --noEmit` is clean and the suite passes under all three isolation modes.
