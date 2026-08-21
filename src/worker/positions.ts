import type { View } from 'copc';
import type { CrsTransform } from '../crs/worker.js';

/**
 * The positions Decision 6 asks the pipeline to encode: an ECEF tile origin
 * and each point's offset from it, small enough for float32 to carry without
 * the jitter absolute ECEF (~6.4e6 m) would cost it.
 */
export interface RelativePositions {
  /** ECEF metres: the midpoint of the transformed points' bounding box. */
  rtcCenter: [number, number, number];
  /** XYZ offsets from `rtcCenter`, one triplet per point, in view order. */
  positions: Float32Array;
}

/**
 * Transforms a decoded view's file coordinates to ECEF and re-expresses them
 * as float32 offsets from the transformed points' own bounding-box midpoint.
 *
 * Decision 6: `rtcCenter` is "the midpoint of the transformed points' ECEF
 * bounding box" — the midpoint of what this tile actually contains, not the
 * node's octree cube (which is padded to a power-of-two split of the root and
 * need not contain any point near its centre) and not any single point (which
 * is a corner of what needs minimising, not its middle).
 *
 * Two passes over one in-memory buffer, per the task: `toEcef` runs once per
 * point in the first pass, which also tracks the box, because the origin
 * cannot be known until every point has been seen; the second pass reuses
 * those same transformed values to write the relatives; `toEcef` is not
 * called again.
 */
export function toRelativePositions(view: View, transform: CrsTransform): RelativePositions {
  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  const count = view.pointCount;

  // Interleaved XYZ, so the second pass below reads back exactly what the
  // first pass computed instead of calling toEcef a second time per point.
  const ecef = new Float64Array(count * 3);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const [x, y, z] = transform.toEcef(getX(i), getY(i), getZ(i));
    ecef[i * 3] = x;
    ecef[i * 3 + 1] = y;
    ecef[i * 3 + 2] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // count === 0 would leave every min/max at its Infinity seed and rtcCenter
  // at NaN, unguarded here. Decision 6's empty-node invariant is what makes
  // that unreachable rather than this function's own job to check:
  // src/tileset/tree.ts's `claim` call registers no content descriptor at
  // all for a pointCount === 0 hierarchy entry ("a zero-point node keeps its
  // tile and loses its content"), so no descriptor — and therefore no
  // chunk — ever reaches decodeChunk or this function for an empty node.
  const rtcCenter: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];

  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (ecef[i * 3] ?? 0) - rtcCenter[0];
    positions[i * 3 + 1] = (ecef[i * 3 + 1] ?? 0) - rtcCenter[1];
    positions[i * 3 + 2] = (ecef[i * 3 + 2] ?? 0) - rtcCenter[2];
  }

  return { rtcCenter, positions };
}
