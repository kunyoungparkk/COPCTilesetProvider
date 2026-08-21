import { CrsCodeNotFoundError, CrsNotRegisteredError } from '../errors/index.js';
import { findHorizontalEpsgCode } from './horizontal-code.js';
import { definitionFor } from './registry.js';

/**
 * Reads a file's WKT and answers with the proj4 definition its coordinates are
 * in, or throws saying why it cannot.
 *
 * This is the main thread's half of Decision 6's order, and it exists as its
 * own step because of Decision 3. The registry is module state, and module
 * state does not cross a realm boundary: a Worker's copy of it holds only
 * EPSG:4326 no matter what the caller registered, so resolving there would
 * reject every real file. What crosses to a Worker is the answer — a plain
 * string, which a message can carry. Only the registry is pinned to this
 * realm: `createTransformFromDefinition` is realm-free, and the main thread
 * builds a transform of its own at `fromUrl` time.
 *
 * Two proj4 features escape that, because they live in realm-global state the
 * string only refers to: a definition naming `+nadgrids` for anything but the
 * self-contained `@null` sentinel needs a grid table loaded by
 * `proj4.nadgrid`, and one written as a `proj4.defs` alias rather than as
 * parameters needs that alias registered. Measured on proj4 2.21, a realm
 * missing either produces `[NaN, NaN]` with nothing but a console line, or
 * throws a value that is not an Error. Neither is supported in v1, and the
 * check lives in `createTransformFromDefinition` — the one chokepoint both
 * consumers pass through — rather than at this seam: the main thread builds a
 * transform too, so a check only here would have let the same definition
 * reach Cesium as half-NaN bounding volumes without a throw. The measurement
 * is in the comment above `rejectUnusableDefinition` in `crs/transform.ts`.
 */
export function resolveCrsDefinition(wkt: string | undefined): string {
  // A file with no WKT at all fails the same way as one whose WKT names no
  // system: either way nobody said which system these coordinates are in.
  const code = wkt === undefined ? null : findHorizontalEpsgCode(wkt);
  if (code === null) {
    throw new CrsCodeNotFoundError();
  }

  const definition = definitionFor(code);
  if (definition === undefined) {
    throw new CrsNotRegisteredError(code);
  }

  return definition;
}
