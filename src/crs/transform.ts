import proj4 from 'proj4';
import { geodeticToEcef } from './ecef.js';

// Restated rather than read out of the registry: 4326 is registered as a
// convenience the caller may replace, and where these coordinates end up is not
// theirs to redefine.
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

export interface CrsTransform {
  /**
   * File coordinates to ECEF metres. `z` is taken to be in the same linear unit
   * as `x` and `y`, which is a v1 limitation of its own alongside OVERVIEW §6's
   * ellipsoidal heights: a file measuring height in a unit its horizontal
   * system does not use comes out vertically scaled.
   */
  toEcef(x: number, y: number, z: number): [number, number, number];
}

/**
 * Metres per unit of a definition's own linear unit.
 *
 * proj4 converts the horizontal pair and hands z back untouched, so the height
 * has to be scaled here or a file in feet arrives claiming to be in metres —
 * 282 metres too high, for this module's own pinned file. Taking the unit from
 * the registered definition takes it from where the horizontal pair already
 * took it. The file's vertical system would be more exactly right and needs the
 * WKT structure walk Decision 6 does without; where the two disagree, as they
 * do on the pinned file, it is an international foot against a US survey foot —
 * two parts per million.
 *
 * proj4 2.21 sets `to_meter` only where the definition names a non-metre linear
 * unit — measured: 0.3048 for `+units=ft`, absent for `+units=m`, for a bare
 * projection, and for `+proj=longlat`. Where it is absent the height is taken
 * to be metres already: right for the first two, and a guess for a geographic
 * definition, whose degrees say nothing about the unit its heights are in.
 */
function metresPerUnit(definition: string): number {
  // Absent from proj4's published `Projection` type, so the field has to be
  // reached for by hand rather than read off the interface.
  const projection = new proj4.Proj(definition) as unknown as { to_meter?: number };
  // Falsy rather than undefined, matching how proj4 itself reads the field: a
  // definition carrying `+to_meter=0` projects normally there, and would
  // otherwise flatten every height in this file to zero here.
  return projection.to_meter || 1;
}

/**
 * Builds the transform from a file's coordinates to ECEF.
 *
 * Takes a proj4 definition rather than the file's WKT, which is Decision 6's
 * order split across Decision 3's realm boundary: `resolveCrsDefinition` reads
 * the WKT and consults the registry on the main thread, and only its answer is
 * posted here. Nothing in this file reaches for the registry, and `worker.ts`
 * is the entry point that keeps it that way — a rule about imports would not,
 * so `tests/crs-worker-boundary.test.ts` walks what that entry can reach.
 *
 * Whole WKT still never reaches proj4. The reason is that which dialects a
 * given proj4 build parses is not predictable, while a registered definition
 * is the one input someone vouched for. (Measured on the pinned file: feeding
 * its compound WKT to proj4 throws, and feeding its PROJCS subtree alone
 * projects correctly — so what is at stake here is unpredictability.)
 *
 * OVERVIEW §6 keeps heights ellipsoidal — a datum offset, not a unit — so z is
 * scaled into metres and otherwise passes through the projection untouched.
 */
export function createTransformFromDefinition(definition: string): CrsTransform {
  const toWgs84 = proj4(definition, WGS84);
  const metresPerZ = metresPerUnit(definition);

  return {
    toEcef(x, y, z) {
      const [longitude, latitude] = toWgs84.forward([x, y]);
      return geodeticToEcef(longitude, latitude, z * metresPerZ);
    },
  };
}
