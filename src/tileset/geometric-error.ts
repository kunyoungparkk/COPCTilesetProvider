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
 * Decision 6 asks for the root's *measured* metre span (실측 미터 span) — the
 * larger of horizontal and vertical — divided by §7's constant. The header
 * is used because it is the measurement: the file's own real data extent.
 * `info.cube` is not a measurement; it is COPC's padded synthetic bounding
 * volume, so it is the wrong input regardless of what number it happens to
 * produce here.
 *
 * On the pinned fixture the two inputs happen to produce the identical
 * double (88.7096992341826933, delta 0). That is fixture-specific, not a
 * general property: COPC pads the cube to a side equal to the *largest* of
 * the header's three spans (not specifically the horizontal one), and on
 * this fixture that largest span already is horizontal — y = 4655.51 ft
 * against z = 209.12 ft. A z-dominant file would pad the cube to its
 * (large) z side, and that same padded length would then also appear on
 * the cube's x and y sides, where the Lambert projection's scale factor
 * (measured on this fixture: ground/grid ≈ 1.0002309, so grid distances
 * read about 0.023% short of ground) inflates it past the header's true,
 * unpadded vertical span — breaking the delta-0 equivalence. Nothing here
 * or in this module's tests would catch a caller who passed `info.cube`
 * instead; the header is used because Decision 6 asks for a measurement,
 * not because a check exists. And the file's units need not be metres —
 * the pinned fixture's are feet — so the span is measured by transforming
 * corner pairs and taking ECEF distances rather than by exposing a unit
 * scale that would be a second way to get the conversion wrong.
 *
 * The three distances are chords rather than geodesics. Measured against the
 * fixture's largest span (1419.355187746923 m), the arc-chord gap is
 * d³/(24R²) ≈ 2.93×10⁻⁶ m — 1.83×10⁻⁷ m once divided by §7's constant, about
 * 360 times larger than the 5×10⁻¹⁰ tolerance the test file pins this
 * function to. Switching to a geodesic here would fail that pin, not pass
 * it more precisely.
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
