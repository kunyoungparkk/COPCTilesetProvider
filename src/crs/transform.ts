import proj4 from 'proj4';
import { CrsDefinitionUnusableError } from '../errors/index.js';
import { geodeticToEcef } from './ecef.js';

// Restated rather than read out of the registry: 4326 is registered as a
// convenience the caller may replace, and where these coordinates end up is not
// theirs to redefine.
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

export interface CrsTransform {
  /**
   * File coordinates to WGS84 degrees and metres.
   *
   * For finite input the height depends only on `z`: proj4 converts the
   * horizontal pair and this module scales the height by the definition's
   * linear unit, so the `x` and `y` passed alongside do not affect it. A
   * non-finite one is the exception, and no height comes back at all —
   * measured, proj4 2.21 `forward([NaN, 848882.15])` throws
   * `TypeError: coordinates must be finite numbers`. The path that can reach
   * it is not point data but `regionForKey`, which feeds `info.cube`'s
   * doubles straight from the VLR.
   */
  toWgs84(x: number, y: number, z: number): [number, number, number];
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
 * Builds a file's transform: `toWgs84` for degrees and metres, `toEcef` for
 * ECEF metres, both off the one projection built here.
 *
 * Takes a proj4 definition rather than the file's WKT, which is Decision 6's
 * order split across Decision 3's realm boundary: `resolveCrsDefinition` reads
 * the WKT and consults the registry on the main thread, and only its answer
 * reaches here — handed over directly by a main-thread caller, or posted to a
 * Worker. Nothing in this file reaches for the registry, and `worker.ts`
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
 *
 * Refuses definitions it cannot carry across the Worker boundary before any
 * of that runs — see `rejectUnusableDefinition` below for why.
 */
export function createTransformFromDefinition(definition: string): CrsTransform {
  rejectUnusableDefinition(definition);

  const toWgs84Projection = proj4(definition, WGS84);
  const metresPerZ = metresPerUnit(definition);

  // Named rather than inlined into both members: the two outputs must come
  // from one projection, or a caller could place a bounding volume by one
  // rule and its points by another.
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const [longitude, latitude] = toWgs84Projection.forward([x, y]);
    return [longitude, latitude, z * metresPerZ];
  };

  return {
    toWgs84: project,
    toEcef(x, y, z) {
      const [longitude, latitude, height] = project(x, y, z);
      return geodeticToEcef(longitude, latitude, height);
    },
  };
}

/**
 * Parses a definition into its `+key=value` terms, mirroring
 * `node_modules/proj4/lib/projString.js`'s own parser exactly: split on `+`,
 * trim each term, split each on the first `=`, lowercase only the key. A term
 * with no `=` gets the value `true` — proj4's own `reduce` does
 * `split.push(true)` before indexing `split[1]`, so a bare `+nadgrids` (no
 * value) ends up as `self.nadgrids = true`, not a string, and this mirrors
 * that for fidelity to proj4's own parser rather than because anything below
 * currently distinguishes `true` from an empty string: both are `!== '@null'`,
 * so a bare `+nadgrids` and a bare `+nadgrids=` are refused identically either
 * way. Values themselves are never lowercased, because proj4 does not
 * lowercase them either — the reason `@NULL` must keep being treated as a
 * real, missing grid name rather than the `@null` sentinel below, pinned by
 * `tests/crs-transform.test.ts`'s `@NULL` test.
 *
 * Reading the definition this way, rather than guessing at proj4's own
 * formatting from outside with a substring or regex, is the same fix C1
 * already applied to `metresPerUnit` above: it makes this guard's
 * classification agree with `projString.js`'s own parser by construction.
 * That parser is only one part of how proj4 decides what a definition means,
 * though — `parseCode.js` gates which strings ever reach it in the first
 * place, a gate this function does not reproduce (see the parked gaps in
 * `rejectUnusableDefinition`'s own comment below).
 */
function parseTerms(definition: string): Map<string, string | true> {
  const terms = new Map<string, string | true>();
  for (const raw of definition.split('+')) {
    const term = raw.trim();
    if (term === '') {
      continue;
    }
    const parts = term.split('=');
    const key = (parts[0] ?? '').toLowerCase();
    terms.set(key, parts.length > 1 ? (parts[1] ?? '') : true);
  }
  return terms;
}

/**
 * Refuses a definition that depends on realm-global proj4 state a string
 * cannot carry across the Worker boundary this module sits on
 * (`crs/README.md`), before `createTransformFromDefinition` builds anything
 * from it. Reads the definition with `parseTerms` and checks two terms
 * directly, rather than a substring or regex guess at proj4's own formatting:
 *
 * - a `nadgrids` term present with any value but the literal string `@null`
 *   names a grid-shift table loaded separately by `proj4.nadgrid` —
 *   `projString.js`'s own handler does the same exact, case-sensitive
 *   comparison (`if (v === '@null') { self.datumCode = 'none'; } else {
 *   self.nadgrids = v; }`), which `parseTerms` preserves by never lowercasing
 *   values. Left unguarded, a missing table does not throw: grid lookup is
 *   deferred to `forward`, called from `regionForKey` and
 *   `measureRootGeometricError`, and there it answers `[NaN, NaN]` with only a
 *   console line — measured on this module's own pinned fixture with
 *   `@missing.gsb` appended, `[NaN, NaN, NaN, NaN, 123.79147200000011,
 *   1542.790920000003]` for a region and `NaN` for a geometric error. The
 *   heights survive because this module scales `z` by `metresPerUnit` and
 *   never routes it through proj4, so a whole tileset of half-NaN bounding
 *   volumes would reach Cesium with nothing thrown.
 * - no `proj` term at all means proj4 has nothing to build a projection from,
 *   for one of two different reasons `reason` tells apart. `'missing-projection'`
 *   if the definition is itself a `+`-parameter string — checked the way
 *   proj4's own `parseCode.js` does, `code[0] === '+'` — that simply never
 *   names one (`+lat_0=41.75 +datum=NAD83`): not an alias, and unrelated to
 *   proj4's built-in table. `'alias'` otherwise — a `proj4.defs` key
 *   (`EPSG:2992`) or bare name that only resolves where that alias was
 *   already registered, which is exactly the module state a Worker does not
 *   inherit. Left unguarded, either throws proj4's own raw, non-`Error`
 *   string — measured, `proj4('+lat_0=41.75 +datum=NAD83', WGS84)` throws
 *   `'Could not get projection name from: ...'`, and `proj4('EPSG:9999',
 *   WGS84)` throws `'Could not parse to valid json: EPSG:9999'`.
 *
 * A parse instead of a substring check closes every blind spot the substring
 * version had, verified against every shape both versions were measured on
 * (`WGS84` in these examples is this module's own constant, not proj4's
 * built-in alias of the same name):
 *
 * - `+NADGRIDS=@missing.gsb` and `+ nadgrids=@missing.gsb` (uppercase key,
 *   space after `+`) used to build without complaint and only answer `[NaN,
 *   NaN]` once `forward` ran — the regex never matched them, so the guard
 *   never ran at all. `parseTerms` lowercases the key and trims the term, so
 *   both are now caught as `'grid-shift'`, same as `@missing.gsb` itself.
 * - `+PROJ=merc` and `+ proj=merc` used to be wrongly refused as `'alias'`,
 *   even though proj4 itself builds and projects both correctly. `parseTerms`
 *   finds their `proj` term regardless of case or the stray space, so both
 *   now build.
 * - a `+nadgrids` term repeated with a safe value last
 *   (`+nadgrids=@missing.gsb +nadgrids=@null`) used to be wrongly refused: the
 *   regex matches the first, unsafe-looking occurrence and never looks past
 *   it. proj4's own `reduce` keeps only the last occurrence of a repeated key,
 *   and measured, that makes the combined definition build and project
 *   correctly — no grid is ever looked up. `parseTerms` uses a `Map`, which
 *   overwrites on repeated `set` calls the same way, so this guard now agrees
 *   and lets it through.
 * - `+init=EPSG:2992 +units=ft` and `+lat_0=41.75 +datum=NAD83` used to be
 *   classified `'alias'`; both are reclassified `'missing-projection'`, which
 *   is what their actual, measured failure is — proj4's own raw string for
 *   each names a missing projection, not an unregistered alias.
 * - `EPSG:2992`, `GOOGLE`, and a WKT string are unchanged, still `'alias'`:
 *   none of them start with `+`, so `parseTerms`'s split finds no `proj` term
 *   in any of them (for the WKT case, measured on this module's own pinned
 *   fixture, whose title happens to itself contain a literal `+` — the parse
 *   turns it into noise no key here matches, so it does not confuse the
 *   check).
 * - a bare `+nadgrids` with no `=` used to escape as `TypeError:
 *   nadgrids.split is not a function`. `parseTerms` gives it the value `true`,
 *   the same value proj4's own parser gives it, and `true !== '@null'` is
 *   just as refusable as any other non-`@null` value — so this is now caught
 *   as `'grid-shift'` too, a typed error instead of an accidental one.
 *
 * One pair is unchanged but only conservatively so: `@null,@conus` and
 * `@conus,@null` are still refused, matching an exact comparison against the
 * literal `'@null'`. `node_modules/proj4/lib/nadgrid.js` only marks a `null`
 * entry with `isNull: true`; the datum-shift loop that actually acts on it —
 * `node_modules/proj4/lib/datum_transform.js:85-92` — breaks to identity the
 * moment it reaches *any* `isNull` entry, wherever it sits in a comma list, so
 * measured, both project without a console line at all: proj4 itself treats
 * them as self-contained. Refusing them anyway is not a bug this guard is
 * fixing, and "a `@null` anywhere in the list is safe" is not a rule this
 * guard should learn on its own authority either: measured,
 * `+nadgrids=conus,@null` — same shape, but `conus` has no leading `@` and is
 * therefore mandatory — hits the loop's *other* branch first
 * (`Unable to find mandatory grid 'conus'`) and answers `[NaN, NaN]` before
 * ever reaching the `@null` entry. Getting that right needs a real
 * comma-list parser with its own mandatory/optional handling, which is a
 * broadening beyond what was asked here, not a correction to it.
 *
 * Two gaps are parked, pre-existing rather than caused by this rewrite, and
 * deliberately left open rather than fixed:
 *
 * - `parseTerms` finds a `proj` term in `' +proj=merc ...'` (a leading space
 *   before the first `+`) because it trims each term after splitting, so this
 *   guard lets it through unrefused. proj4's own `parseCode.js` decides
 *   whether to attempt parameter-string parsing at all by checking only the
 *   definition's first character (`code[0] === '+'`, no trim), so a leading
 *   space there means proj4 never calls `projString` on it in the first
 *   place. Measured: `proj4(' +proj=merc ...', WGS84)` throws
 *   `'Could not parse to valid json: ...'`, proj4's own raw, non-`Error`
 *   string — a loud escape, not a silent one, and closing it needs
 *   `parseCode.js`'s own first-character gate ahead of `parseTerms`, which
 *   this function does not have.
 * - a WKT string reaching this function is classified `'alias'`, and that
 *   message is false of it: a WKT is self-contained (no realm-global state
 *   involved) and, measured on this module's own pinned fixture, proj4
 *   builds and projects its `PROJCS` subtree correctly. `parseTerms` never
 *   finds a `proj` term in it (it does not start with `+`), so it falls into
 *   the same bucket as a genuine alias. Fixing this needs a fourth `reason`
 *   and a way to recognise WKT (`parseCode.js`'s own `testWKT` checks for `[`
 *   with no leading `+`), which is more than this task's guard should grow to
 *   cover — Decision 6's own split (`resolveCrsDefinition` on the main
 *   thread, `createTransformFromDefinition` realm-free) means WKT should
 *   never actually reach here in this library's own flow; only a caller
 *   invoking `createTransformFromDefinition` directly with WKT, bypassing
 *   `resolveCrsDefinition`, would see this.
 */
function rejectUnusableDefinition(definition: string): void {
  const terms = parseTerms(definition);

  const nadgrids = terms.get('nadgrids');
  if (nadgrids !== undefined && nadgrids !== '@null') {
    throw new CrsDefinitionUnusableError(definition, 'grid-shift');
  }

  if (!terms.has('proj')) {
    throw new CrsDefinitionUnusableError(
      definition,
      definition.startsWith('+') ? 'missing-projection' : 'alias',
    );
  }
}
