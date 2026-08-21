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
    // The spans are metres because the transform scales the file's feet. The
    // largest is y: a bug that took x instead would land at 65.280489507
    // (off by 23.4 m), and one that took z instead would land at
    // 3.983735999979 (off by 84.7 m) -- tens of metres either way, not the
    // hundreds a coarser guess might expect.
    expect(measureRootGeometricError(autzenHeader(), transform)).toBeCloseTo(
      88.709_699_234_182_7,
      9,
    );
  });

  it('takes the vertical span when the data is taller than it is wide', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Decision 6 takes the larger of horizontal and vertical so that a
    // vertically long cloud keeps refining. A 1-foot footprint 10000 feet
    // tall is the case that separates "largest span" from "largest horizontal
    // span" -- the second rule would give 0.019 m here.
    const tall: Pick<Las.Header, 'min' | 'max'> = {
      min: [635_577.79, 848_882.15, 0],
      max: [635_578.79, 848_883.15, 10_000],
    };

    // 10000 ft = 3048 m; 3048 / 16 = 190.5
    expect(measureRootGeometricError(tall, transform)).toBeCloseTo(190.5, 6);
  });

  it('takes the horizontal span along x when it is the largest', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Neither test above makes the x span (the first `Math.max` argument)
    // win -- Autzen's largest span is y and the tall fixture's is z -- so a
    // slip reading `minX` for `maxX` on that first argument passes the whole
    // suite (measured: it does, before this test existed). Mirrors the tall
    // fixture but stretched along easting instead of height.
    const wide: Pick<Las.Header, 'min' | 'max'> = {
      min: [635_577.79, 848_882.15, 0],
      max: [645_577.79, 848_883.15, 1],
    };

    // Unlike the tall fixture's vertical span, x is projected (Lambert
    // conformal conic) before ECEF, so 10000 ft does not land on its flat
    // metre equivalent: 10000 ft * 0.3048 = 3048 m. Measured on this
    // fixture, the Lambert grid's point scale factor here is k =
    // grid/ground ~= 0.9997692 -- below 1, as it should be for a point
    // between the projection's standard parallels (43 deg / 45.5 deg) --
    // so ground distance is the reciprocal, ~1.0002309x grid: the
    // fixture's own transform gives a span of 3048.703720809729 m here,
    // not 3048; 3048.703720809729 / 16 = 190.543982550608
    expect(measureRootGeometricError(wide, transform)).toBeCloseTo(190.543_982_550_608_1, 9);
  });
});

describe('geometricErrorAtDepth', () => {
  it('halves once per depth', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));
    // Read from measureRootGeometricError rather than copied as a literal, so
    // a change to that function's own output cannot silently drift out of
    // sync with what this block asserts against -- only the four expected
    // values below are hand-derived (root / 2**depth by hand, not by calling
    // this module), so the comparison isn't circular with the code under test.
    const root = measureRootGeometricError(autzenHeader(), transform);

    // root = 88.709699234182693 (see the "divides the largest..." test above
    // for its own derivation from the fixture).
    //   depth 0:  88.709699234182693 / 1    = 88.709699234182693
    //   depth 1:  88.709699234182693 / 2    = 44.354849617091347
    //   depth 5:  88.709699234182693 / 32   =  2.772178101068209
    //   depth 12: 88.709699234182693 / 4096 =  0.021657641414595
    // Depth 0 catches both `2 * depth` (divides by zero) and an off-by-one
    // exponent like `2 ** (depth + 1)`. Depth 5 catches a linear denominator
    // such as `/(depth + 1)` (would give 14.78, not 2.77). Depth 12 -- well
    // past Autzen's own hierarchy depth -- catches a capped exponent like
    // `2 ** Math.min(depth, 5)`, which reproduces every value above through
    // depth 5 and only diverges here. No mutation tried needs depth 1 alone;
    // it is asserted for the ordinary reason of pinning the halving step
    // between the two.
    expect(geometricErrorAtDepth(root, 0)).toBeCloseTo(88.709_699_234_182_7, 9);
    expect(geometricErrorAtDepth(root, 1)).toBeCloseTo(44.354_849_617_091_3, 9);
    expect(geometricErrorAtDepth(root, 5)).toBeCloseTo(2.772_178_101_068_2, 9);
    expect(geometricErrorAtDepth(root, 12)).toBeCloseTo(0.021_657_641_414_6, 9);
  });
});
