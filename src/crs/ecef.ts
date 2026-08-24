// WGS84, whose shape is defined by a flattening rather than by a second axis.
// The squared first eccentricity follows from it, so it is derived here.
const SEMI_MAJOR = 6_378_137;
const FLATTENING = 1 / 298.257_223_563;
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Converts geodetic coordinates to Earth-centred, Earth-fixed metres.
 *
 * `height` is ellipsoidal (HAE) by the time it reaches here: `createTransformFromDefinition`
 * (`transform.ts`) is the one place that applies a caller's `geoidHeight`, adding it after
 * the linear-unit scaling and before `project` calls this function. A file storing
 * orthometric heights whose caller gave no `geoidHeight` still sits at a vertical
 * offset — OVERVIEW §6 keeps automatic, grid-based correction out of scope for v1 —
 * but a known offset is no longer uncorrectable, only uncorrected by default.
 */
export function geodeticToEcef(
  longitude: number,
  latitude: number,
  height: number,
): [number, number, number] {
  const lon = toRadians(longitude);
  const lat = toRadians(latitude);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);

  // Radius of curvature in the prime vertical: how far the surface normal
  // travels before it meets the spin axis, which is what height is measured
  // along — not along a ray from the centre.
  const n = SEMI_MAJOR / Math.sqrt(1 - ECCENTRICITY_SQUARED * sinLat * sinLat);

  return [
    (n + height) * cosLat * Math.cos(lon),
    (n + height) * cosLat * Math.sin(lon),
    (n * (1 - ECCENTRICITY_SQUARED) + height) * sinLat,
  ];
}
