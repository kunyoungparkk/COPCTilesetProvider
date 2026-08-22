import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { geodeticToEcef, registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
// The Worker's entry point, imported here the way the Worker will import it.
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { CrsDefinitionUnusableError } from '../src/errors/index.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Autzen Stadium, Eugene, Oregon — where the file's own points actually are.
const STADIUM = { longitude: -123.0681, latitude: 44.0582 };

// EPSG:2992 is in international feet, so the file's x and y are, and the
// transform takes its z to be the same. Every height below is therefore a foot
// count until it is scaled. (The file's VERT_CS actually names the US survey
// foot — two parts per million away, or 0.37 mm at this file's greatest
// height, and it costs the WKT structure walk to read.)
const FOOT = 0.3048;

/**
 * Metres between two ECEF points.
 *
 * Assertions live in ECEF rather than in degrees on purpose. Inverting ECEF
 * back to geodetic latitude is not the one-liner it looks like — `atan2(z,
 * hypot(x, y))` gives the *geocentric* latitude, which at Autzen is 0.19°
 * away from the geodetic one, or 21 km. Comparing in the space the function
 * actually returns avoids inventing a second, subtly wrong implementation just
 * to phrase the check.
 */
const metresApart = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

describe('both halves against the real file', () => {
  it('puts Autzen\'s own points over Autzen Stadium', async () => {
    // Both halves, in the order the library runs them: the main thread
    // resolves a definition out of the WKT, and the Worker would build the
    // transform from that string alone.
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Horizontal placement only: both sides sit at height zero, which is the
    // one height that means the same thing in feet and in metres, so nothing
    // here can stand in for the vertical check below.
    const centre = transform.toEcef(
      (635_577.79 + 639_003.73) / 2,
      (848_882.15 + 853_537.66) / 2,
      0,
    );
    const stadium = geodeticToEcef(STADIUM.longitude, STADIUM.latitude, 0);

    // Measured at 0.22 km, which is right for a cloud covering rather more
    // than the stadium itself. A kilometre of tolerance still catches a gross
    // failure of the horizontal pair — swapped axes, the wrong definition —
    // because each of those moves the result much further than that.
    expect(metresApart(centre, stadium)).toBeLessThan(1000);
  });

  it('is stable at the corners as well as the centre', async () => {
    // Both halves, in the order the library runs them: the main thread
    // resolves a definition out of the WKT, and the Worker would build the
    // transform from that string alone.
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    const corner = transform.toEcef(635_577.79, 848_882.15, 406.14);
    // The pinned measurement, converted through the ECEF step
    // tests/crs-ecef.test.ts verifies against closed-form values. This is a
    // regression pin, not an accuracy
    // check: it holds the wiring still, and says nothing proj4 does not. The
    // height is written in metres because that is what toEcef returns; the
    // 406.14 above is the file's own number, which is feet.
    const expected = geodeticToEcef(-123.07499, 44.04972, 406.14 * FOOT);

    expect(metresApart(corner, expected)).toBeLessThan(5);
  });

  it('takes z in the same linear unit as x and y', async () => {
    // Both halves, in the order the library runs them: the main thread
    // resolves a definition out of the WKT, and the Worker would build the
    // transform from that string alone.
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Two points on one vertical line are exactly their height difference
    // apart, so this isolates the vertical scale from wherever proj4 puts the
    // horizontal pair — and, unlike a comparison that spends the same literal
    // on both sides, it cannot be satisfied by leaving z alone.
    const low = transform.toEcef(637_290.76, 851_209.9, 0);
    const high = transform.toEcef(637_290.76, 851_209.9, 1000);

    // A thousand of the file's feet is 304.8 metres. Reading them as metres
    // would make this 1000; over the file's own 406-to-615-foot z range that
    // same mistake lifts its points 282 to 428 metres.
    expect(metresApart(high, low)).toBeCloseTo(1000 * FOOT, 6);
  });

  it('reports degrees and metres, from the same projection toEcef uses', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    const [longitude, latitude, height] = transform.toWgs84(635_577.79, 848_882.15, 406.14);

    // The file's own header minimum. proj4 owns the horizontal pair, so this
    // is a deliberately coarse pin: six decimals is a 5e-7° budget — 5.6 cm of
    // latitude, 4.0 cm of longitude here — and proj4 2.21 lands 3.5e-9 and
    // 1.2e-9 from these literals, under 1% of it either way. They keep proj4's
    // digits past the sixth deliberately: rounded to what the check reads,
    // they would sit far closer to the edge of that budget. `proj4` is a
    // `^2.21.0` range here, and a pin tight enough to read its last digits
    // would go red on a patch release that moved them with nothing actually
    // wrong.
    //
    // Below this budget nothing here catches a horizontal error: adding
    // 4.9e-7° to the longitude — a systematic 3.9 cm shift — passes the whole
    // suite, measured. That is an accepted gap, not coverage living somewhere
    // else. The test below pins only that the two members agree with each
    // other, so it stays green on a wrong longitude too. proj4 owns this
    // number, and 4 cm is invisible at globe scale beside the ellipsoidal
    // heights OVERVIEW §6 already accepts.
    expect(longitude).toBeCloseTo(-123.074_986_74, 6);
    expect(latitude).toBeCloseTo(44.049_718_82, 6);
    // 406.14 international feet in, metres out — which is the direction the
    // height must be converted: 406.14 * 0.3048 = 123.791472 m exactly.
    expect(height).toBeCloseTo(123.791_472, 9);
  });

  it('agrees with toEcef, which is built on it', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    // Not a restatement of the implementation: `toEqual` is exact, so any
    // divergence between the two members at this one input fails here.
    // Measured, and each sits under every other test's tolerance: a toWgs84
    // that rounds its own output, and a 3.9 cm error injected on the toEcef
    // side alone, which nothing else in the suite catches. What it cannot see
    // includes whatever moves both sides alike — an error in the step they
    // share, or a differently built projection, proj4 2.21 returning
    // bit-identical doubles both for a second build of the same definition and
    // for a NAD83 two-hop.
    const [longitude, latitude, height] = transform.toWgs84(637_290.76, 851_209.9, 500);

    expect(transform.toEcef(637_290.76, 851_209.9, 500)).toEqual(
      geodeticToEcef(longitude, latitude, height),
    );
  });
});

describe('createTransformFromDefinition where there is no usable linear unit', () => {
  it('leaves z in metres', () => {
    // A geographic system's coordinates are degrees and its heights are
    // already metres. proj4 reports no `to_meter` at all there, so the scale
    // has to fall back to one — a fallback nothing else here would notice
    // going wrong.
    const transform = createTransformFromDefinition('+proj=longlat +datum=WGS84 +no_defs');

    const low = transform.toEcef(STADIUM.longitude, STADIUM.latitude, 0);
    const high = transform.toEcef(STADIUM.longitude, STADIUM.latitude, 1000);

    expect(metresApart(high, low)).toBeCloseTo(1000, 6);
  });

  it('ignores a degenerate to_meter, as proj4 itself does', () => {
    // proj4 reads this field falsily (`lib/transform.js` guards the horizontal
    // scale with `if (source.to_meter)`), so `+to_meter=0` projects x and y as
    // though it were absent. Reading it by type here instead would agree with
    // proj4 on the horizontal pair and multiply every height by zero — the
    // cloud flattened onto one surface, with no error anywhere.
    const transform = createTransformFromDefinition(
      `${OREGON.replace('+units=ft', '')} +to_meter=0`,
    );

    const low = transform.toEcef(637_290.76, 851_209.9, 0);
    const high = transform.toEcef(637_290.76, 851_209.9, 1000);

    expect(metresApart(high, low)).toBeCloseTo(1000, 6);
  });
});

describe('createTransformFromDefinition refuses what it cannot carry across a realm', () => {
  it('refuses a +nadgrids definition instead of returning a transform that answers NaN', () => {
    // Without this guard, building this transform does not throw at all —
    // proj4 defers grid lookup to `forward`, so the failure would only show
    // up later as NaN coordinates and a console line. See the measurement in
    // `src/crs/transform.ts`, above `rejectUnusableDefinition`.
    let caught: unknown;
    try {
      createTransformFromDefinition(`${OREGON} +nadgrids=@missing.gsb`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('refuses a proj4.defs alias instead of a self-contained parameter string', () => {
    // Without this guard, proj4 itself throws here — but a bare string, not
    // an `Error`, which most catch blocks and every `instanceof Error` check
    // let through unnoticed.
    let caught: unknown;
    try {
      createTransformFromDefinition('EPSG:2992');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('alias');
  });

  it('builds a transform for +nadgrids=@null, which is self-contained', () => {
    // The canonical EPSG:3857 string `global.js` and epsg.io both publish —
    // `@null` is proj4's own sentinel for "no datum shift", not a table name,
    // so this must not be refused even though it contains `+nadgrids=`.
    const EPSG_3857 =
      '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 ' +
      '+k=1.0 +units=m +nadgrids=@null +no_defs';

    const transform = createTransformFromDefinition(EPSG_3857);
    const [longitude, latitude] = transform.toWgs84(-13_580_977, 5_895_835, 0);

    // Measured: no throw, no console line, and real (non-NaN) coordinates —
    // the opposite of what a missing grid produces.
    expect(longitude).toBeCloseTo(-121.999_992_123_756_87, 6);
    expect(latitude).toBeCloseTo(46.715_965_373_686_46, 6);
  });

  it('refuses @nullisland.gsb, which is not the @null sentinel', () => {
    // Pins the guard's exact comparison: `nadgrids !== '@null'`, string
    // equality against the whole value `parseTerms` reads, not a prefix or
    // substring test. A grid literally named `@nullisland.gsb` shares the
    // sentinel's first four characters, so a check that only looked at a
    // prefix (or that failed to trim the term first) would wrongly treat this
    // as self-contained too.
    let caught: unknown;
    try {
      createTransformFromDefinition(`${OREGON} +nadgrids=@nullisland.gsb`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('refuses @NULL, which is not the (case-sensitive) @null sentinel', () => {
    // Pins the value-case rule: `parseTerms` lowercases keys but never
    // values, matching proj4's own `nadgrids` handler, which does an exact,
    // case-sensitive `v === '@null'` comparison. Measured directly: proj4
    // builds `${OREGON} +nadgrids=@NULL` without throwing and then answers
    // `forward` with `[NaN, NaN]` and a console line naming `'NULL'` — the
    // same half-NaN escape a missing grid produces. Lowercasing values in
    // `parseTerms` would make this pass instead of throw, silently
    // reproducing that escape.
    let caught: unknown;
    try {
      createTransformFromDefinition(`${OREGON} +nadgrids=@NULL`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('refuses a +nadgrids definition even when it would also fail to build', () => {
    // Separates the two guards' ordering from each other: this proj4 build
    // throws its own raw string the moment an unbuildable +proj= reaches it
    // (measured: `proj4('+proj=notaprojection +nadgrids=@missing.gsb', WGS84)`
    // throws `'Could not get projection name from: ...'`), so if the
    // grid-shift check ran after that call it would never get the chance to
    // run at all — unlike the alias check, whose ordering the test above
    // already pins.
    let caught: unknown;
    try {
      createTransformFromDefinition('+proj=notaprojection +nadgrids=@missing.gsb');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('refuses +NADGRIDS=, whose uppercase key a substring check would miss', () => {
    // Before the parse-based rewrite, this built without complaint and only
    // answered [NaN, NaN] once `forward` ran — the exact half-NaN outcome
    // this guard exists to abolish. `parseTerms` lowercases the key, so this
    // is now caught the same as `+nadgrids=@missing.gsb` itself.
    let caught: unknown;
    try {
      createTransformFromDefinition(`${OREGON} +NADGRIDS=@missing.gsb`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('refuses "+ nadgrids=", whose stray space a substring check would miss', () => {
    let caught: unknown;
    try {
      createTransformFromDefinition(`${OREGON} + nadgrids=@missing.gsb`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('refuses a bare +nadgrids with no value, instead of leaking a raw TypeError', () => {
    // Before the parse-based rewrite, this reached proj4 as
    // `TypeError: nadgrids.split is not a function` — an accidental Error,
    // not a typed one. `parseTerms` gives a valueless term `true`, the same
    // value proj4's own parser gives it, and `true !== '@null'` refuses it
    // here instead.
    let caught: unknown;
    try {
      createTransformFromDefinition(`${OREGON} +nadgrids`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('grid-shift');
  });

  it('builds +PROJ=merc, whose uppercase key a substring check would wrongly refuse', () => {
    // Before the parse-based rewrite, this was wrongly refused as 'alias',
    // even though proj4 itself builds and projects it correctly.
    const EPSG_3857_UPPER =
      '+PROJ=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 ' +
      '+k=1.0 +units=m +no_defs';

    const transform = createTransformFromDefinition(EPSG_3857_UPPER);
    const [longitude, latitude] = transform.toWgs84(-13_580_977, 5_895_835, 0);

    expect(longitude).toBeCloseTo(-121.999_992_123_756_87, 6);
    expect(latitude).toBeCloseTo(46.715_965_373_686_46, 6);
  });

  it('builds "+ proj=merc", whose stray space a substring check would wrongly refuse', () => {
    const EPSG_3857_SPACED =
      '+ proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 ' +
      '+k=1.0 +units=m +no_defs';

    const transform = createTransformFromDefinition(EPSG_3857_SPACED);
    const [longitude, latitude] = transform.toWgs84(-13_580_977, 5_895_835, 0);

    expect(longitude).toBeCloseTo(-121.999_992_123_756_87, 6);
    expect(latitude).toBeCloseTo(46.715_965_373_686_46, 6);
  });

  it('builds a repeated +nadgrids= term whose last, safe value wins', () => {
    // Before the parse-based rewrite, this was wrongly refused: a substring
    // regex matches the first, unsafe-looking occurrence and never looks
    // past it. proj4's own `reduce` keeps only the last occurrence of a
    // repeated key — measured, the combined definition builds and projects
    // correctly, with no grid ever looked up — and `parseTerms`'s `Map`
    // overwrites on repeated `set` the same way.
    const transform = createTransformFromDefinition(
      `${OREGON} +nadgrids=@missing.gsb +nadgrids=@null`,
    );

    const [longitude, latitude] = transform.toWgs84(635_577.79, 848_882.15, 0);

    expect(longitude).toBeCloseTo(-123.074_986_74, 6);
    expect(latitude).toBeCloseTo(44.049_718_82, 6);
  });

  it('refuses a +-string with no projection term as missing-projection, not alias', () => {
    // This shape is not an alias, and its failure has nothing to do with
    // proj4's built-in table or version drift — it is a `+`-parameter string
    // that simply never names a projection. If this reason were folded back
    // into 'alias', this assertion would fail.
    let caught: unknown;
    try {
      createTransformFromDefinition('+lat_0=41.75 +datum=NAD83');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('missing-projection');
  });

  it('reclassifies +init=..., a shape that used to be called an alias', () => {
    // +init= is an old proj4.js form this build no longer parses at all; its
    // actual, measured failure (`'Could not get projection name from: ...'`)
    // is the same missing-projection failure as any other +-string with no
    // +proj= term, not an unregistered alias.
    let caught: unknown;
    try {
      createTransformFromDefinition('+init=EPSG:2992 +units=ft');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CrsDefinitionUnusableError);
    expect((caught as CrsDefinitionUnusableError).reason).toBe('missing-projection');
  });
});
