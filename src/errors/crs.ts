import { CopcTilesetError } from './base.js';

/**
 * No horizontal EPSG code could be read from the file's WKT.
 *
 * Unlike an unregistered code, there is nothing for the caller to register —
 * the file did not say which system its coordinates are in, so the file is what
 * has to change.
 */
export class CrsCodeNotFoundError extends CopcTilesetError {
  readonly code = 'crs-code-not-found';

  constructor() {
    super(
      'No horizontal EPSG code could be read from this file\'s coordinate system ' +
        'description. Its WKT either names no authority or names one this library does ' +
        'not recognise, so there is nothing to look up. Re-writing the file with a ' +
        'current PDAL — `pdal translate input.laz output.copc.laz --writers.copc.a_srs=EPSG:<code>` ' +
        '— will record a system that can be read.',
    );
  }
}

/**
 * The file names a coordinate system nobody registered.
 *
 * Decision 6 registers only EPSG:4326 by default, because there is no
 * predicting which systems arrive and a partial built-in table would be worse
 * than one clear rule. The message therefore has to do the work: it carries the
 * code the file asked for, already inside the call that fixes it.
 */
export class CrsNotRegisteredError extends CopcTilesetError {
  readonly code = 'crs-not-registered';
  readonly epsgCode: number;

  constructor(epsgCode: number) {
    super(
      `This file uses EPSG:${epsgCode}, which is not registered. Only EPSG:4326 is ` +
        'known by default, so every other system has to be supplied once, before the ' +
        'file is opened:\n\n' +
        `    registerCrs(${epsgCode}, '<proj4 definition>');\n\n` +
        `The definition for EPSG:${epsgCode} is at https://epsg.io/${epsgCode} — take ` +
        'its proj4 string. Its accuracy is yours to vouch for; this library only ' +
        'applies what it is given.',
    );
    this.epsgCode = epsgCode;
  }
}

/**
 * A registered proj4 definition depends on state that only exists in the
 * realm that registered it, and that a Worker never receives (OVERVIEW §3,
 * Decision 3): `resolveCrsDefinition` hands a Worker the definition string
 * alone, not the process it ran in.
 *
 * Three shapes of that: `'grid-shift'` for a `+nadgrids` grid-shift table (any
 * value but the self-contained `@null` sentinel), which is loaded into a
 * process-global table by `proj4.nadgrid` and is not part of the definition
 * string; `'alias'` for a `proj4.defs` key (`EPSG:2992`, a name nobody but
 * this realm ever registered) rather than a `+`-parameter string at all;
 * `'missing-projection'` for a `+`-parameter string that never names a
 * projection (`+lat_0=41.75 +datum=NAD83`) — this one is not an alias and has
 * nothing to do with proj4's built-in table, so it gets its own reason rather
 * than sharing `'alias'`'s message.
 */
export class CrsDefinitionUnusableError extends CopcTilesetError {
  readonly code = 'crs-definition-unusable';
  readonly definition: string;
  readonly reason: 'grid-shift' | 'alias' | 'missing-projection';

  constructor(definition: string, reason: 'grid-shift' | 'alias' | 'missing-projection') {
    super(formatMessage(definition, reason));
    this.definition = definition;
    this.reason = reason;
  }
}

/**
 * The alias case's fix is a `registerCrs` call, same as `CrsNotRegisteredError`
 * — but only when the definition is itself an `EPSG:<code>` string, since
 * that is the one shape this error sees that already names the code to put in
 * it. A bare alias like `GOOGLE` has no code to extract, so it gets the prose
 * form instead.
 */
function formatMessage(
  definition: string,
  reason: 'grid-shift' | 'alias' | 'missing-projection',
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
    ? `Expand it into its full parameter string and register that instead:\n\n` +
      `    registerCrs(${epsgMatch[1]}, '<proj4 definition>');\n\n` +
      `https://epsg.io/${epsgMatch[1]} lists one.`
    : 'Expand it into its full `+proj=...` parameter string — for an EPSG code, ' +
      'https://epsg.io/<code> lists one — and register that instead.';

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
