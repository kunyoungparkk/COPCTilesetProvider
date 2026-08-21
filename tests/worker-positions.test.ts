import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileHeader } from '../src/copc/header.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
// The Worker's entry point, imported here the way the Worker will import it —
// createTransformFromDefinition is realm-free but reaches no registry
// (tests/crs-worker-boundary.test.ts enforces that for this barrel).
import { createTransformFromDefinition } from '../src/crs/worker.js';
import type { CrsTransform } from '../src/crs/worker.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';
import { decodeChunk } from '../src/worker/decode.js';
import { toRelativePositions } from '../src/worker/positions.js';
import { autzenWkt } from './autzen-wkt.js';

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

// Same proj4 definition tests/crs-transform.test.ts registers for EPSG:2992 —
// Autzen's own horizontal system, in international feet.
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Half a float32's relative spacing (the gap between 1 and the next
// representable float32 is 2**-23) — the bound on a single round-to-nearest
// rounding error, not the spacing itself. Used below for both the
// round-trip tolerance and the half-extent tolerance, so a mutation that
// only weakens one of them by reusing the wrong constant is still caught by
// the other.
const FLOAT32_ROUNDING_BOUND = 2 ** -24;

describe('toRelativePositions', () => {
  // Computed once in beforeAll and read by every it below, so each property
  // is asserted in its own test: a failure names the property that failed,
  // and one property can be watched fail while the others stay green — which
  // is what makes a mutation's blast radius readable here.
  let pointCount: number;
  let rtcCenter: [number, number, number];
  let positions: Float32Array;
  let toEcefCalls: number;
  // An independent box: every point's ECEF, computed fresh off the real
  // transform (not the counting wrapper below, so this loop doesn't inflate
  // toEcefCalls), straight off the same transform tests/crs-transform.test.ts
  // already checks against Autzen Stadium's real coordinates. Properties 2
  // and 3 are stated against this box, never against anything
  // toRelativePositions computed internally.
  let ecef: [number, number, number][];
  let minX: number;
  let minY: number;
  let minZ: number;
  let maxX: number;
  let maxY: number;
  let maxZ: number;

  beforeAll(async () => {
    // Same node tests/worker-decode.test.ts decodes: the file's smallest
    // (47 points), so its numbers stay checkable by hand.
    const { header } = await readFileHeader(bufferReader(fixture('autzen-head.bin')));
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
    const view = await decodeChunk(fixture('autzen-node-5-16-3-1.bin'), header, entry.pointCount);
    pointCount = view.pointCount;

    registerCrs(2992, OREGON);
    const realTransform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // A counting wrapper around toEcef: `toRelativePositions`'s doc comment
    // claims toEcef runs exactly once per point (the whole point of the
    // two-pass, one-buffer design), and nothing else here would notice a
    // regression that quietly called it a second time per point — every
    // other assertion below only inspects rtcCenter and positions, both of
    // which a doubled call could still get right.
    toEcefCalls = 0;
    const countingTransform: CrsTransform = {
      toWgs84: realTransform.toWgs84,
      toEcef(x, y, z) {
        toEcefCalls++;
        return realTransform.toEcef(x, y, z);
      },
    };

    const result = toRelativePositions(view, countingTransform);
    rtcCenter = result.rtcCenter;
    positions = result.positions;

    const getX = view.getter('X');
    const getY = view.getter('Y');
    const getZ = view.getter('Z');
    ecef = [];
    minX = Infinity;
    minY = Infinity;
    minZ = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    maxZ = -Infinity;
    for (let i = 0; i < view.pointCount; i++) {
      const point = realTransform.toEcef(getX(i), getY(i), getZ(i));
      ecef.push(point);
      minX = Math.min(minX, point[0]);
      maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
      minZ = Math.min(minZ, point[2]);
      maxZ = Math.max(maxZ, point[2]);
    }
  });

  it('shapes positions to one XYZ triplet per point and calls toEcef exactly once per point', () => {
    expect(positions.length).toBe(pointCount * 3);
    expect(toEcefCalls).toBe(pointCount);
  });

  it('property 1: reproduces the transformed ECEF within float32 resolution, worst case over all points', () => {
    // The tolerance is float32's own rounding bound (half its relative
    // spacing, 2**-24) times the largest relative magnitude in this chunk —
    // not a round number, and specific to this chunk's own magnitudes. The
    // largest relative magnitude is computed independently in the next test
    // (property 3's worst*), so it is recomputed here rather than shared,
    // keeping each `it` a self-contained property.
    let maxAbsRelative = 0;
    for (let i = 0; i < pointCount; i++) {
      maxAbsRelative = Math.max(
        maxAbsRelative,
        Math.abs(positions[i * 3] ?? 0),
        Math.abs(positions[i * 3 + 1] ?? 0),
        Math.abs(positions[i * 3 + 2] ?? 0),
      );
    }
    const tolerance = maxAbsRelative * FLOAT32_ROUNDING_BOUND;

    let worstRoundTripError = 0;
    for (let i = 0; i < pointCount; i++) {
      const expected = ecef[i] ?? [0, 0, 0];
      const reconstructedX = rtcCenter[0] + (positions[i * 3] ?? 0);
      const reconstructedY = rtcCenter[1] + (positions[i * 3 + 1] ?? 0);
      const reconstructedZ = rtcCenter[2] + (positions[i * 3 + 2] ?? 0);
      worstRoundTripError = Math.max(
        worstRoundTripError,
        Math.abs(reconstructedX - expected[0]),
        Math.abs(reconstructedY - expected[1]),
        Math.abs(reconstructedZ - expected[2]),
      );
    }
    expect(worstRoundTripError).toBeLessThanOrEqual(tolerance);
  });

  it('properties 2 and 3: the origin sits inside the box, and no relative exceeds half its extent', () => {
    // Property 2: the origin lies within the box on every axis.
    expect(rtcCenter[0]).toBeGreaterThanOrEqual(minX);
    expect(rtcCenter[0]).toBeLessThanOrEqual(maxX);
    expect(rtcCenter[1]).toBeGreaterThanOrEqual(minY);
    expect(rtcCenter[1]).toBeLessThanOrEqual(maxY);
    expect(rtcCenter[2]).toBeGreaterThanOrEqual(minZ);
    expect(rtcCenter[2]).toBeLessThanOrEqual(maxZ);

    // Property 3: no relative exceeds half the box's own extent on its axis.
    // This is the property that fails if the origin comes from anything but
    // these points — mathematically, half the extent is exactly the distance
    // from a true box midpoint to the point sitting at that axis's own
    // extreme (`max - (min+max)/2 == (max-min)/2` identically), so there is
    // no double-precision slack in this bound at all for the correct
    // implementation. Measured directly: a node-cube-centre origin (Step 5
    // mutation 1) loosens this to worst relatives of 17.65 / 14.74 / 31.24 m
    // against true half-extents of 3.72 / 3.39 / 2.94 m; a first-point
    // origin (mutation 3) loosens the X axis alone to 7.44 m. Once
    // `positions` is float32, though, the extremal point's relative can
    // round a few ULPs past the float64 half-extent — measured, 6.1e-8 m
    // past it here — so the tolerance below is float32's own rounding bound
    // (half its relative spacing), not slack in the geometric claim itself.
    const halfExtentX = (maxX - minX) / 2;
    const halfExtentY = (maxY - minY) / 2;
    const halfExtentZ = (maxZ - minZ) / 2;
    let worstX = 0;
    let worstY = 0;
    let worstZ = 0;
    for (let i = 0; i < pointCount; i++) {
      worstX = Math.max(worstX, Math.abs(positions[i * 3] ?? 0));
      worstY = Math.max(worstY, Math.abs(positions[i * 3 + 1] ?? 0));
      worstZ = Math.max(worstZ, Math.abs(positions[i * 3 + 2] ?? 0));
    }
    expect(worstX).toBeLessThanOrEqual(halfExtentX * (1 + FLOAT32_ROUNDING_BOUND));
    expect(worstY).toBeLessThanOrEqual(halfExtentY * (1 + FLOAT32_ROUNDING_BOUND));
    expect(worstZ).toBeLessThanOrEqual(halfExtentZ * (1 + FLOAT32_ROUNDING_BOUND));
  });

  it('pins the origin and point 0 exactly', () => {
    // Properties 1-3 above are all stated *relative to the same transform*:
    // each recomputes its own box or round trip from whatever `toEcef`
    // currently returns, so all three are invariant to any upstream change
    // that moves every point the same way. Measured: mutating
    // src/crs/ecef.ts's SEMI_MAJOR by +1 m moves every point ~0.39 m, and
    // forcing src/crs/transform.ts's metresPerUnit to always return 1 (as
    // if this file's feet were metres) moves every point ~151 m — both
    // leave properties 1-3 green (they only ever compare the function's
    // output against itself) and redden only this pin, which is this
    // module's one absolute anchor: golden values read back from a single
    // known-good run rather than derived a second way, because there is no
    // independent closed-form arithmetic for a 47-point box midpoint the way
    // tests/worker-decode.test.ts's point-0 pin has for scale/offset.
    //
    // 6 decimal places for rtcCenter (ECEF metres, ~5e-7 m) and 5 for the
    // relatives (float32, ~1e-5 m at this magnitude) — tight enough to catch
    // either mutation above by four to five orders of magnitude, loose
    // enough for ordinary floating-point noise between runs.
    expect(rtcCenter[0]).toBeCloseTo(-2_505_234.608_518_916, 6);
    expect(rtcCenter[1]).toBeCloseTo(-3_847_990.649_652_401, 6);
    expect(rtcCenter[2]).toBeCloseTo(4_412_295.864_508_179, 6);
    expect(positions[0]).toBeCloseTo(3.717_665_195_465_088, 5);
    expect(positions[1]).toBeCloseTo(-2.379_110_097_885_132, 5);
    expect(positions[2]).toBeCloseTo(-1.512_000_679_969_787_6, 5);
  });
});
