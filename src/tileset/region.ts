import { Bounds } from 'copc';
import type { NodeKey } from '../copc/index.js';
import type { CrsTransform } from '../crs/index.js';

/**
 * OVERVIEW §7: samples taken along each edge of a node's cube, corners
 * included. Not monotone in k: each k re-samples at different positions
 * (`along = index / (k - 1)`), so a larger k's samples are not a superset
 * of a smaller one's, and padding can shrink when k grows -- measured on
 * this fixture, k=4 gives a narrower latitude padding (3.059e-7 deg) than
 * either k=3 or k=5 (3.442e-7 deg each). What holds instead: an even k
 * skips the exact midpoint (`along = 0.5`), where the deviation measured
 * here peaks, and undermeasures it; any odd k samples that point, and 5
 * already equals what k=1001 converges to. Raising it trades projections
 * for slack this fixture's own peak doesn't need, not for accuracy.
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
