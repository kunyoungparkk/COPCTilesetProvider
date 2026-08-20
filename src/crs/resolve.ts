import { CrsCodeNotFoundError, CrsNotRegisteredError } from '../errors/index.js';
import { findHorizontalEpsgCode } from './horizontal-code.js';
import { definitionFor } from './registry.js';

/**
 * Reads a file's WKT and answers with the proj4 definition its coordinates are
 * in, or throws saying why it cannot.
 *
 * This is the main thread's half of Decision 6's order, and it exists as its
 * own step because of Decision 3. The transform runs in a Worker, and module
 * state does not cross a realm boundary: a Worker's copy of the registry holds
 * only EPSG:4326 no matter what the caller registered, so resolving there would
 * reject every real file. What crosses is the answer — a plain string, which a
 * message can carry.
 *
 * Two proj4 features escape that, because they live in realm-global state the
 * string only refers to: a definition naming `+nadgrids` needs a grid table
 * loaded by `proj4.nadgrid`, and one written as a `proj4.defs` alias rather
 * than as parameters needs that alias registered. Measured on proj4 2.21, a
 * Worker missing either produces `[NaN, NaN]` with nothing but a console line,
 * or throws a value that is not an Error. Neither is supported in v1; the seam
 * that posts this string is where a check for them belongs.
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
