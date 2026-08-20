// WGS84, whose shape is defined by a flattening rather than by a second axis.
// The squared first eccentricity follows from it, so it is derived here.
const SEMI_MAJOR = 6_378_137;
const FLATTENING = 1 / 298.257_223_563;
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Converts geodetic coordinates to Earth-centred, Earth-fixed metres.
 *
 * OVERVIEW §6 treats every height as ellipsoidal: geoid correction is out of
 * scope for v1, so a file storing orthometric heights sits at a vertical
 * offset. §6 requires the README to record that limitation once there is one.
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
