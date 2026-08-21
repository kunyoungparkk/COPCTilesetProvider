import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { geodeticToEcef, registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
// The Worker's entry point, imported here the way the Worker will import it.
import { createTransformFromDefinition } from '../src/crs/worker.js';

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
    // The pinned measurement, converted through the ECEF step Task 3 verified
    // against closed-form values. This is a regression pin, not an accuracy
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
