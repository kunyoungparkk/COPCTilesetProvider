import proj4 from 'proj4';
import { CrsCodeNotFoundError, CrsDefinitionRequiredError } from '../errors/index.js';
import { findHorizontalCrs } from './epsg-codes.js';
import { NULL_SHIFT_DATUMS } from './null-shift-datums.js';

/**
 * Reads a file's WKT and answers with the definition its coordinates are in —
 * the WKT of its horizontal system alone — or throws saying why it cannot.
 *
 * Decision 6: the file's own description is used only where it is enough to
 * place the points on WGS84 without a guess. Two things make it not enough.
 * A compound WKT makes proj4 throw, so only the horizontal node is handed
 * over (`findHorizontalCrs`). And a WKT that does not state a datum shift
 * gets none from proj4, which is right only for a datum EPSG publishes a zero
 * shift for (`NULL_SHIFT_DATUMS`); for any other, the caller has to pass a
 * definition with the shift written in. The table's own comment has the
 * measurement behind both.
 *
 * This runs on the main thread, at `fromUrl` time, because its failures have
 * to reject `fromUrl`: thrown inside a Worker, the same error would reach the
 * caller as an opaque `messageerror`. What crosses to a Worker is the answer,
 * a plain string a message can carry.
 *
 * Two proj4 features the string cannot carry — a `+nadgrids` table and a
 * `proj4.defs` alias — are refused by `createTransformFromDefinition` instead,
 * the one chokepoint the file's definition and a caller's `crs` both pass
 * through. The measurement is in the comment above `rejectUnusableDefinition`
 * in `crs/transform.ts`.
 */
export function resolveCrsDefinition(wkt: string): string {
  const horizontal = findHorizontalCrs(wkt);
  if (horizontal === null) {
    throw new CrsCodeNotFoundError();
  }

  if (horizontal.datumCode === null || !NULL_SHIFT_DATUMS.has(horizontal.datumCode)) {
    throw new CrsDefinitionRequiredError(horizontal.code, 'datum-shift-unknown');
  }

  // Parsed here rather than left to the transform, which knows no EPSG code
  // to name: measured, proj4 2.21 cannot read 35 of EPSG's own WKT1 systems
  // (Hartebeesthoek94's Lo zones among them), and throws a bare string.
  try {
    new proj4.Proj(horizontal.wkt);
  } catch {
    throw new CrsDefinitionRequiredError(horizontal.code, 'wkt-unreadable');
  }

  return horizontal.wkt;
}
