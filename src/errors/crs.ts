import { CopcTilesetError } from './base.js';

/**
 * No horizontal EPSG code could be read from the file's WKT.
 *
 * The file did not say which system its coordinates are in, in a form this
 * library can read. The caller can say it instead, or the file can be
 * re-written to say it.
 */
export class CrsCodeNotFoundError extends CopcTilesetError {
  readonly code = 'crs-code-not-found';

  constructor() {
    super(
      'No horizontal EPSG code could be read from this file\'s coordinate system ' +
        'description. Its WKT either names no authority or names one this library does ' +
        'not recognise. If you know the system, pass its definition when opening the file:\n\n' +
        "    COPCTilesetProvider.fromUrl(url, { crs: '<proj4 definition>' });\n\n" +
        'Or re-write the file with a current PDAL — ' +
        '`pdal translate input.laz output.copc.laz --writers.copc.a_srs=EPSG:<code>` ' +
        '— so it records a system that can be read.',
    );
  }
}

/**
 * The file names its coordinate system, but this library cannot place it on
 * WGS84 from the file alone, so the caller has to supply the definition
 * (Decision 6).
 *
 * `'datum-shift-unknown'`: the system's datum is not one EPSG publishes a
 * zero shift to WGS84 for (`crs/null-shift-datums.ts`). proj4 would apply no
 * shift and every point would land tens to hundreds of metres off with
 * nothing thrown, so the file is refused instead. `'wkt-unreadable'`: proj4
 * could not parse the file's own description of the system.
 *
 * The message carries the code the file names and the call that fixes it.
 */
export class CrsDefinitionRequiredError extends CopcTilesetError {
  readonly code = 'crs-definition-required';
  readonly epsgCode: number;
  readonly reason: 'datum-shift-unknown' | 'wkt-unreadable';

  constructor(epsgCode: number, reason: 'datum-shift-unknown' | 'wkt-unreadable') {
    const why =
      reason === 'datum-shift-unknown'
        ? `This file uses EPSG:${epsgCode}, whose datum needs a shift to reach WGS84 that ` +
          'the file does not state. Without one, every point would land tens to hundreds ' +
          'of metres off with no error, so the file is refused. Pass a definition that ' +
          'states the shift (for proj4, a `+towgs84=` term) when opening the file:'
        : `This file uses EPSG:${epsgCode}, but its own description of that system could ` +
          'not be read. Pass a definition when opening the file:';
    super(
      `${why}\n\n` +
        "    COPCTilesetProvider.fromUrl(url, { crs: '<proj4 definition>' });\n\n" +
        `The definition for EPSG:${epsgCode} is at https://epsg.io/${epsgCode} — take ` +
        'its proj4 string. Its accuracy is yours to vouch for; this library only ' +
        'applies what it is given.',
    );
    this.epsgCode = epsgCode;
    this.reason = reason;
  }
}

/**
 * A coordinate system definition depends on proj4 state that only exists in
 * the realm that set it up, and that a Worker never receives (OVERVIEW §3,
 * Decision 3): a Worker is handed the definition string alone, not the
 * process it was resolved in.
 *
 * Three shapes of that: `'grid-shift'` for a `+nadgrids` grid-shift table (any
 * value but the self-contained `@null` sentinel), which is loaded into a
 * process-global table by `proj4.nadgrid` and is not part of the definition
 * string; `'alias'` for a `proj4.defs` key (`EPSG:2992`, a name nobody but
 * this realm ever defined) rather than a `+`-parameter string or WKT;
 * `'missing-projection'` for a `+`-parameter string that never names a
 * projection (`+lat_0=41.75 +datum=NAD83`) — this one is not an alias and has
 * nothing to do with proj4's built-in table, so it gets its own reason rather
 * than sharing `'alias'`'s message. And `'unreadable'` for a WKT proj4 cannot
 * parse at all — not a realm problem, but refused at the same chokepoint so
 * a caller's `crs` fails typed rather than with proj4's bare string.
 */
export class CrsDefinitionUnusableError extends CopcTilesetError {
  readonly code = 'crs-definition-unusable';
  readonly definition: string;
  readonly reason: 'grid-shift' | 'alias' | 'missing-projection' | 'unreadable';

  constructor(
    definition: string,
    reason: 'grid-shift' | 'alias' | 'missing-projection' | 'unreadable',
  ) {
    super(formatMessage(definition, reason));
    this.definition = definition;
    this.reason = reason;
  }
}

/**
 * The alias case's fix is the full definition, passed as `crs` — and when the
 * definition is itself an `EPSG:<code>` string, the message can say where to
 * find it, since that is the one shape this error sees that already names the
 * code. A bare alias like `GOOGLE` has no code to extract, so it gets the
 * prose form instead.
 */
function formatMessage(
  definition: string,
  reason: 'grid-shift' | 'alias' | 'missing-projection' | 'unreadable',
): string {
  if (reason === 'grid-shift') {
    return (
      `This coordinate system definition carries a \`+nadgrids\` term that ` +
      `is not the self-contained value \`@null\` — naming a grid-shift table, ` +
      `or naming none at all:\n\n    ${definition}\n\n` +
      'A `+nadgrids` term (other than the literal value `@null`) only works where ' +
      'that grid file has already been loaded with `proj4.nadgrid`, which a Worker ' +
      'never has done. Replace the definition with an equivalent one that carries ' +
      'no such `+nadgrids` term.'
    );
  }

  if (reason === 'unreadable') {
    return (
      `proj4 could not read this coordinate system definition:\n\n    ${definition}\n\n` +
      'Pass a proj4 parameter string (`+proj=...`) as `crs` instead — for an EPSG ' +
      'code, https://epsg.io/<code> lists one.'
    );
  }

  if (reason === 'missing-projection') {
    return (
      `This coordinate system definition never names a projection:\n\n` +
      `    ${definition}\n\n` +
      'Every proj4 parameter string needs a `+proj=<name>` term — this one carries ' +
      'other parameters but not that one, so proj4 has nothing to build a ' +
      'projection from. Add the missing `+proj=<name>` term; the definition at ' +
      'https://epsg.io/<code>, if this coordinate system has an EPSG code, has one.'
    );
  }

  const epsgMatch = /^EPSG:(\d+)$/i.exec(definition.trim());
  const expand = epsgMatch
    ? `Expand it into its full parameter string and pass that instead:\n\n` +
      `    COPCTilesetProvider.fromUrl(url, { crs: '<proj4 definition>' });\n\n` +
      `https://epsg.io/${epsgMatch[1]} lists one.`
    : 'Expand it into its full `+proj=...` parameter string — for an EPSG code, ' +
      'https://epsg.io/<code> lists one — and pass that as `crs` instead.';

  return (
    `This coordinate system definition is a name rather than a self-contained ` +
    `parameter string:\n\n    ${definition}\n\n` +
    'A bare code or alias like this is not a coordinate system by itself — what ' +
    'it resolves to depends on whichever proj4 build reads it. Some, like ' +
    '`WGS84` or `EPSG:3857`, are baked into proj4 itself and could change ' +
    'between versions; anything else needs its own `proj4.defs` call, which ' +
    `this library never makes. Either way the string alone does not carry the ` +
    `definition. ${expand}`
  );
}

/**
 * `geoidHeight` reached `createTransformFromDefinition` as something other
 * than a finite number — `NaN`, or a value that was never a number to begin
 * with.
 *
 * Nothing downstream catches this on its own. proj4's own finite-number guard
 * (`CrsTransform.toWgs84`'s own doc comment) fires only on the `[x, y]` pair
 * `forward` receives; `geoidHeight` never reaches `forward` at all — it is
 * added to `z` after the projection returns. Left unguarded, a `NaN` reaches
 * `regionForKey`'s bounding volume and `JSON.stringify` silently writes
 * `null` into the synthetic tileset's `region` array — measured, against the
 * Autzen fixture `transform.ts`'s own tests are pinned to: `geoidHeight: NaN`
 * gives `toWgs84` `[-123.0687, 44.0562, NaN]`, and `geoidHeight: '5'` (a value
 * that was never a number, such as an unparsed API response field) still
 * poisons `toEcef` to `[NaN, NaN, NaN]`. Neither throws anywhere on its own.
 */
export class CrsGeoidHeightNotFiniteError extends CopcTilesetError {
  readonly code = 'crs-geoid-height-not-finite';
  readonly geoidHeight: unknown;

  constructor(geoidHeight: unknown) {
    super(
      `geoidHeight must be a finite number of metres, but received ` +
        `${describeReceivedGeoidHeight(geoidHeight)}. Pass the geoid separation N in metres ` +
        `(for example -23.333), or 0 for a file whose heights are already ellipsoidal.`,
    );
    this.geoidHeight = geoidHeight;
  }
}

/**
 * Renders the value this error names, truthfully, for both cases the
 * validation was written to reject.
 *
 * `JSON.stringify` collapses `NaN` and `Infinity` to the text `null` — there
 * is no JSON representation for either, so a caller whose calculation
 * produced `NaN` would read a message claiming it passed `null`. `String`
 * does not have that problem (`String(NaN)` is `"NaN"`), but it has the
 * opposite one for strings: `String('5')` is `5`, indistinguishable from the
 * number `5` — erasing exactly the distinction the "not a number at all"
 * case exists to report. Quoting only strings, and using `String` for
 * everything else, keeps both distinctions visible.
 */
function describeReceivedGeoidHeight(geoidHeight: unknown): string {
  return typeof geoidHeight === 'string' ? JSON.stringify(geoidHeight) : String(geoidHeight);
}
