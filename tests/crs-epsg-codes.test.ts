import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import {
  findHorizontalCrs,
  findVerticalEpsgCode,
  findVerticalUnit,
} from '../src/crs/epsg-codes.js';

// The code alone, which is all these tests are about; the datum code and the
// WKT that come with it are `tests/crs-resolve.test.ts`'s.
const horizontalCode = (wkt: string): number | null => findHorizontalCrs(wkt)?.code ?? null;

describe('findHorizontalCrs against the real file', () => {
  // The whole reason this module exists. Autzen's WKT holds ten AUTHORITY
  // nodes; the horizontal one is neither the first nor the last.
  it('finds the projected system and not the vertical datum', async () => {
    const wkt = await autzenWkt();

    expect(horizontalCode(wkt)).toBe(2992);
  });

  it('does not return any of the other nine codes', async () => {
    const code = horizontalCode(await autzenWkt());

    // 6360 is the vertical datum a trailing match finds; 7019 is the spheroid
    // a leading one finds; 4269 is the geographic system nested inside PROJCS.
    expect([6360, 7019, 4269, 6269, 8901, 9122, 9002, 5103, 9003]).not.toContain(code);
  });
});

describe('findHorizontalCrs on constructed systems', () => {
  it('reads a bare projected system', () => {
    const wkt = 'PROJCS["x",GEOGCS["g",AUTHORITY["EPSG","4269"]],AUTHORITY["EPSG","2992"]]';

    expect(horizontalCode(wkt)).toBe(2992);
  });

  // A geographic file has no PROJCS, and then GEOGCS is the horizontal system.
  it('falls back to the geographic system when there is no projected one', () => {
    const wkt = 'GEOGCS["WGS 84",DATUM["d",AUTHORITY["EPSG","6326"]],AUTHORITY["EPSG","4326"]]';

    expect(horizontalCode(wkt)).toBe(4326);
  });

  // The coordinates here are Lambert, in feet. Answering with the geographic
  // system nested inside would read Autzen's easting of 635577 feet as degrees,
  // so a projected system that names no EPSG code resolves to nothing at all.
  it('returns null when the projected system carries no EPSG code', () => {
    const wkt =
      'PROJCS["Oregon",GEOGCS["NAD83",AUTHORITY["EPSG","4269"]],AUTHORITY["ESRI","102726"]]';

    expect(horizontalCode(wkt)).toBeNull();
  });

  it('takes the projected system when a compound holds both orders', () => {
    const wkt =
      'COMPD_CS["c",VERT_CS["v",AUTHORITY["EPSG","6360"]],' +
      'PROJCS["p",AUTHORITY["EPSG","2992"]]]';

    expect(horizontalCode(wkt)).toBe(2992);
  });

  // The tie-break is keyword-scoped, and the pinned file reaches it only
  // through its UNIT nodes, where the outcome is invisible. Pinned here on a
  // keyword that is read back instead. No writer emits this either, so the
  // rule is arbitrary — which is the reason to pin it rather than to leave it
  // for the next edit to reverse unnoticed.
  it('takes the later of two authorities under a repeated keyword', () => {
    const wkt =
      'COMPD_CS["c",GEOGCS["a",AUTHORITY["EPSG","4269"]],' +
      'GEOGCS["b",AUTHORITY["EPSG","4326"]]]';

    expect(horizontalCode(wkt)).toBe(4326);
  });

  // A system's name is free text, so a bracket inside one must not be counted
  // as structure. An unbalanced one is what actually shifts every later depth.
  it('is not confused by a bracket inside a quoted name', () => {
    const wkt = 'PROJCS["Oregon ]draft",AUTHORITY["EPSG","2992"]]';

    expect(horizontalCode(wkt)).toBe(2992);
  });

  // Formatted WKT puts a line break between a keyword and its bracket, which
  // must not read as a nameless node.
  it('reads a system whose keyword does not touch its bracket', () => {
    const wkt =
      'PROJCS ["x",\n  GEOGCS ["g",\n    AUTHORITY ["EPSG", "4269"]],\n' +
      '  AUTHORITY ["EPSG", "2992"]]';

    expect(horizontalCode(wkt)).toBe(2992);
  });

  it('ignores an authority that is not EPSG', () => {
    const wkt = 'PROJCS["x",AUTHORITY["ESRI","102726"]]';

    expect(horizontalCode(wkt)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a system with no authority at all', 'PROJCS["x",UNIT["foot",0.3048]]'],
    ['a vertical system alone', 'VERT_CS["v",AUTHORITY["EPSG","6360"]]'],
    ['text that is not WKT', 'not wkt at all'],
  ])('returns null for %s', (_label, wkt) => {
    expect(horizontalCode(wkt)).toBeNull();
  });
});

describe('findVerticalEpsgCode', () => {
  // The whole point: this is how the library learns a file measures height
  // from a geoid rather than from the ellipsoid.
  it('finds the vertical system in the real file', async () => {
    expect(findVerticalEpsgCode(await autzenWkt())).toBe(6360);
  });

  it('reads the vertical system out of a compound, whichever order it is in', () => {
    const wkt =
      'COMPD_CS["c",VERT_CS["v",AUTHORITY["EPSG","6360"]],' +
      'PROJCS["p",AUTHORITY["EPSG","2992"]]]';

    expect(findVerticalEpsgCode(wkt)).toBe(6360);
  });

  // A file with no vertical system says nothing about its heights, and the
  // caller reads that null as "no warning to give".
  it('returns null when there is no vertical system', () => {
    const wkt = 'PROJCS["x",GEOGCS["g",AUTHORITY["EPSG","4269"]],AUTHORITY["EPSG","2992"]]';

    expect(findVerticalEpsgCode(wkt)).toBeNull();
  });

  // The vertical datum sits one level below the vertical system and carries a
  // code of its own (5103 in the pinned file). Reading that one instead would
  // name a datum where the caller expects a CRS.
  it('takes the vertical system and not the vertical datum inside it', () => {
    const wkt =
      'VERT_CS["NAVD88",VERT_DATUM["d",2005,AUTHORITY["EPSG","5103"]],AUTHORITY["EPSG","6360"]]';

    expect(findVerticalEpsgCode(wkt)).toBe(6360);
  });
});

describe('findVerticalUnit', () => {
  // Autzen's heights are in US survey feet and its horizontal system is in
  // international feet. Only the vertical system's own unit says so.
  it('reads the unit of the vertical system in the real file', async () => {
    expect(findVerticalUnit(await autzenWkt())).toBe(0.304800609601219);
  });

  // The shape of autzen-2023 in the public hobu-lidar bucket: metres across,
  // US survey feet up. Reading the horizontal unit here is the whole bug.
  it('takes the vertical unit and not the horizontal one beside it', () => {
    const wkt =
      'COMPD_CS["c",PROJCS["p",UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","6557"]],' +
      'VERT_CS["v",VERT_DATUM["d",2005,AUTHORITY["EPSG","5103"]],' +
      'UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]],AXIS["Up",UP]]]';

    expect(findVerticalUnit(wkt)).toBe(0.3048006096012192);
  });

  // No vertical system is no statement about heights at all. The caller reads
  // null as "use the horizontal definition's unit", so the foot here must not
  // be mistaken for one.
  it('returns null when there is no vertical system', () => {
    expect(findVerticalUnit('PROJCS["p",UNIT["foot",0.3048],AUTHORITY["EPSG","2992"]]')).toBeNull();
  });

  it('returns null when the vertical system states no unit', () => {
    expect(findVerticalUnit('VERT_CS["v",VERT_DATUM["d",2005],AXIS["Up",UP]]')).toBeNull();
  });

  // A unit of zero would flatten every height, and a negative one would turn
  // the file upside down, with nothing thrown.
  it.each(['0', '-0.3048', 'feet'])('returns null for a unit of %s', (factor) => {
    expect(findVerticalUnit(`VERT_CS["v",VERT_DATUM["d",2005],UNIT["u",${factor}]]`)).toBeNull();
  });
});
