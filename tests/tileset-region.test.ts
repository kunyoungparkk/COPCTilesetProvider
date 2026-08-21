import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Info, Las } from 'copc';
import type { Bounds } from 'copc';
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
    // longitude, 3.44e-7 deg of latitude). Pinned to 12 digits, three more
    // than `precision` checks, so rounding the literal itself never eats a
    // meaningful share of the 5e-10 tolerance -- measured margin here is
    // under 5e-13 on all four, versus up to 98.7% of the budget at 9 digits.
    expect(west * DEGREES).toBeCloseTo(-123.075_542_258_471, 9);
    expect(south * DEGREES).toBeCloseTo(44.049_718_474_631, 9);
    expect(east * DEGREES).toBeCloseTo(-123.057_284_529_060, 9);
    expect(north * DEGREES).toBeCloseTo(44.062_885_832_507, 9);
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

    // Not an independent path: both halves call the same transform over the
    // same fixture bytes, and at depth 0 Bounds.stepTo returns its cube
    // unchanged, so stepping never runs. What this is worth is a cheap guard
    // against a gross unit or sign error, reached a different way than the
    // root pin above -- not a second, unrelated defence.
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

  it('does not confuse which axis a child bit selects', async () => {
    // 'keeps a child inside its parent' loops over all eight children, so a
    // key.x/key.y or key.y/key.z swap in the Bounds.stepTo call is invisible
    // to it: permuting the bits just relabels which iteration produces which
    // (still valid, still contained) child. These two children each differ
    // from the root in exactly one axis. Verified by running both swaps: an
    // x/y swap moves both children -- each becomes the other's own pinned
    // value below -- while a y/z swap moves only childY, because childX's
    // key has y = z = 0, making that swap a no-op on it; only childY's pins
    // catch it.
    const cube = autzenInfo().cube;
    const transform = await transformFor();

    const childX = regionForKey(cube, { depth: 1, x: 1, y: 0, z: 0 }, transform);
    expect(childX[0] * DEGREES).toBeCloseTo(-123.066_412_447_771, 9);
    expect(childX[1] * DEGREES).toBeCloseTo(44.049_918_664_210, 9);
    expect(childX[2] * DEGREES).toBeCloseTo(-123.057_284_551_545, 9);
    expect(childX[3] * DEGREES).toBeCloseTo(44.056_501_829_639, 9);
    expect(childX[4]).toBeCloseTo(123.791_472, 6);
    expect(childX[5]).toBeCloseTo(833.291_196, 6);

    const childY = regionForKey(cube, { depth: 1, x: 0, y: 1, z: 0 }, transform);
    expect(childY[0] * DEGREES).toBeCloseTo(-123.075_542_236_014, 9);
    expect(childY[1] * DEGREES).toBeCloseTo(44.056_102_440_129, 9);
    expect(childY[2] * DEGREES).toBeCloseTo(-123.066_412_432_824, 9);
    expect(childY[3] * DEGREES).toBeCloseTo(44.062_686_288_458, 9);
    expect(childY[4]).toBeCloseTo(123.791_472, 6);
    expect(childY[5]).toBeCloseTo(833.291_196, 6);
  });

  it('is wider than its corners alone would be', async () => {
    // Decision 6 samples the edges because a projection is nonlinear, so a
    // straight line between an edge's own endpoints can miss the curve
    // between them. The padding folded into the box below is measured on
    // this cube's north edge for latitude (3.44e-7 deg, 0.038 m) and its west
    // edge for longitude (2.99e-8 deg); the two comments below explain which
    // corner each assertion compares against and why.
    const cube = autzenInfo().cube;
    const transform = await transformFor();
    const region = regionForKey(cube, { depth: 0, x: 0, y: 0, z: 0 }, transform);

    // The region's south bound is set by the south-west corner: the raw,
    // unpadded sample there is bit-identical to this corner projected
    // directly, so region.south equals swLatitude minus exactly the
    // latitude padding -- a padding of zero would fail this by equality.
    const [, swLatitude] = transform.toWgs84(cube[0], cube[1], 0);
    // The region's west bound, by contrast, is set by the north-west corner,
    // not this same south-west one: comparing against south-west instead (as
    // this test originally did) passes unconditionally, because south-west's
    // longitude already sits ~44 m east of the true west bound regardless of
    // any padding.
    const [nwLongitude] = transform.toWgs84(cube[0], cube[4], 0);

    expect(region[0] * DEGREES).toBeLessThan(nwLongitude);
    expect(region[1] * DEGREES).toBeLessThan(swLatitude);
  });
});

describe('regionForKey on a synthetic cube', () => {
  it('recovers an interior maximum a corners-only sample would miss', async () => {
    // On the Autzen cube every edge is monotonic in both longitude and
    // latitude, so its true extremes always sit at a corner and a
    // corners-only box (still widened by the full padding this module
    // measures) is bit-identical to the real one -- confirmed by running
    // that exact mutation (guard the four Math.min/Math.max updates to
    // sample 0 and SAMPLES_PER_EDGE - 1 only, leave the padding loop
    // untouched) against it. This cube is built to break that by crossing
    // the projection's actual central meridian: PROJ reads `+x_0` in
    // metres even though this definition says `+units=ft`, so lon_0 =
    // -120.5 sits at grid x = 400,000 m / 0.3048 = 1,312,335.958 ft, not at
    // x_0's own bare number -- and this cube's 1,800,000 ft width crosses
    // that point. Asymmetry about it is not what makes this work: a cube
    // centred on it is caught harder, not less (measured, at a 500,000 ft
    // half-width: 1.56e-2 deg there against 3.59e-3 deg for this cube), so
    // this cube's margin below is comfortable, not maximal. Measured
    // directly: the north edge's true maximum latitude sits at an interior
    // sample, 400 m above what the edge's own two corners alone reach.
    const transform = await transformFor();
    const HALF = 900_000; // ft
    // Arbitrary; chosen only so the cube above crosses x = 1,312,335.958 ft.
    const centerX = 399_999.9999984 + 300_000;
    const cube: Bounds = [centerX - HALF, -HALF, 0, centerX + HALF, HALF, 100];

    const [, , , north] = regionForKey(cube, { depth: 0, x: 0, y: 0, z: 0 }, transform);

    // Measured: the correct region's north bound is 44.26896 deg; that exact
    // mutation's corners-only-but-still-padded box reaches only 44.26537 deg.
    // This threshold sits between the two, with comfortable margin either way.
    expect(north * DEGREES).toBeGreaterThan(44.267);
  });
});
