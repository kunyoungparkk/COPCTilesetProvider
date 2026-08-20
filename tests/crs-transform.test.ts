import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';
import { describe, expect, it } from 'vitest';
import { createTransform, geodeticToEcef, registerCrs } from '../src/crs/index.js';

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

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

async function autzenWkt(): Promise<string> {
  const header = Las.Header.parse(load('autzen-head.bin').subarray(0, 375));
  const region = load('autzen-vlrs.bin');
  const base = header.headerLength;
  const get = (begin: number, end: number): Promise<Uint8Array> =>
    Promise.resolve(region.subarray(begin - base, end - base));
  const vlrs = await Las.Vlr.walk(get, {
    headerLength: base,
    vlrCount: header.vlrCount,
    evlrOffset: 0,
    evlrCount: 0,
  });
  const record = Las.Vlr.at(vlrs, 'LASF_Projection', 2112);
  const start = record.contentOffset - base;
  return new TextDecoder()
    .decode(region.subarray(start, start + record.contentLength))
    .replace(/\0+$/, '');
}

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

describe('createTransform against the real file', () => {
  it('puts Autzen\'s own points over Autzen Stadium', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransform(await autzenWkt());

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
    // than the stadium itself. A kilometre of tolerance still catches every
    // gross failure — swapped axes, feet read as metres, the wrong definition
    // — because each of those moves the result much further than that.
    expect(metresApart(centre, stadium)).toBeLessThan(1000);
  });

  it('is stable at the corners as well as the centre', async () => {
    registerCrs(2992, OREGON);
    const transform = createTransform(await autzenWkt());

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
    registerCrs(2992, OREGON);
    const transform = createTransform(await autzenWkt());

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
});

describe('createTransform where the definition gives no usable linear unit', () => {
  it('leaves z in metres', () => {
    // 4326 is the one system Decision 6 registers by default, its coordinates
    // are degrees, and its heights are already metres. proj4 reports no
    // `to_meter` at all there, so the scale has to fall back to one — a
    // fallback nothing else in this file would notice going wrong.
    const transform = createTransform('GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]');

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
    // An unassigned code: registering a degenerate definition under a real one
    // would leave a trap for whichever test file runs next, since the registry
    // is process-wide.
    registerCrs(99_999, `${OREGON.replace('+units=ft', '')} +to_meter=0`);
    const transform = createTransform('PROJCS["degenerate",AUTHORITY["EPSG","99999"]]');

    const low = transform.toEcef(637_290.76, 851_209.9, 0);
    const high = transform.toEcef(637_290.76, 851_209.9, 1000);

    expect(metresApart(high, low)).toBeCloseTo(1000, 6);
  });
});

describe('createTransform error paths', () => {
  it('names the code and how to register it', () => {
    const wkt = 'PROJCS["somewhere",AUTHORITY["EPSG","31370"]]';

    expect(() => createTransform(wkt)).toThrow(
      expect.objectContaining({ code: 'crs-not-registered', epsgCode: 31_370 }),
    );
    // Decision 6 promises the reader can select the indented line and run it,
    // so the call in the message has to be the form this barrel exports — a
    // bare `registerCrs`. Decision 6 also plans a static method on the
    // provider; the day that is what a caller can reach, this pin fails, which
    // is the only thing that will make the message change with it.
    expect(() => createTransform(wkt)).toThrow("\n    registerCrs(31370, '");
  });

  it('rejects a file whose WKT names no system', () => {
    expect(() => createTransform('PROJCS["x",UNIT["foot",0.3048]]')).toThrow(
      expect.objectContaining({ code: 'crs-code-not-found' }),
    );
  });

  it('rejects a file with no WKT at all', () => {
    expect(() => createTransform(undefined)).toThrow(
      expect.objectContaining({ code: 'crs-code-not-found' }),
    );
  });
});
