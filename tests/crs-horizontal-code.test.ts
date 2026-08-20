import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';
import { describe, expect, it } from 'vitest';
import { findHorizontalEpsgCode } from '../src/crs/horizontal-code.js';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

/** Autzen's real WKT, read out of the pinned VLR region. */
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

describe('findHorizontalEpsgCode against the real file', () => {
  // The whole reason this module exists. Autzen's WKT holds ten AUTHORITY
  // nodes; the horizontal one is neither the first nor the last.
  it('finds the projected system and not the vertical datum', async () => {
    const wkt = await autzenWkt();

    expect(findHorizontalEpsgCode(wkt)).toBe(2992);
  });

  it('does not return any of the other nine codes', async () => {
    const code = findHorizontalEpsgCode(await autzenWkt());

    // 6360 is the vertical datum a trailing match finds; 7019 is the spheroid
    // a leading one finds; 4269 is the geographic system nested inside PROJCS.
    expect([6360, 7019, 4269, 6269, 8901, 9122, 9002, 5103, 9003]).not.toContain(code);
  });
});

describe('findHorizontalEpsgCode on constructed systems', () => {
  it('reads a bare projected system', () => {
    const wkt = 'PROJCS["x",GEOGCS["g",AUTHORITY["EPSG","4269"]],AUTHORITY["EPSG","2992"]]';

    expect(findHorizontalEpsgCode(wkt)).toBe(2992);
  });

  // A geographic file has no PROJCS, and then GEOGCS is the horizontal system.
  it('falls back to the geographic system when there is no projected one', () => {
    const wkt = 'GEOGCS["WGS 84",DATUM["d",AUTHORITY["EPSG","6326"]],AUTHORITY["EPSG","4326"]]';

    expect(findHorizontalEpsgCode(wkt)).toBe(4326);
  });

  // The coordinates here are Lambert, in feet. Answering with the geographic
  // system nested inside would read Autzen's easting of 635577 feet as degrees,
  // so a projected system that names no EPSG code resolves to nothing at all.
  it('returns null when the projected system carries no EPSG code', () => {
    const wkt =
      'PROJCS["Oregon",GEOGCS["NAD83",AUTHORITY["EPSG","4269"]],AUTHORITY["ESRI","102726"]]';

    expect(findHorizontalEpsgCode(wkt)).toBeNull();
  });

  it('takes the projected system when a compound holds both orders', () => {
    const wkt =
      'COMPD_CS["c",VERT_CS["v",AUTHORITY["EPSG","6360"]],' +
      'PROJCS["p",AUTHORITY["EPSG","2992"]]]';

    expect(findHorizontalEpsgCode(wkt)).toBe(2992);
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

    expect(findHorizontalEpsgCode(wkt)).toBe(4326);
  });

  // A system's name is free text, so a bracket inside one must not be counted
  // as structure. An unbalanced one is what actually shifts every later depth.
  it('is not confused by a bracket inside a quoted name', () => {
    const wkt = 'PROJCS["Oregon ]draft",AUTHORITY["EPSG","2992"]]';

    expect(findHorizontalEpsgCode(wkt)).toBe(2992);
  });

  // Formatted WKT puts a line break between a keyword and its bracket, which
  // must not read as a nameless node.
  it('reads a system whose keyword does not touch its bracket', () => {
    const wkt =
      'PROJCS ["x",\n  GEOGCS ["g",\n    AUTHORITY ["EPSG", "4269"]],\n' +
      '  AUTHORITY ["EPSG", "2992"]]';

    expect(findHorizontalEpsgCode(wkt)).toBe(2992);
  });

  it('ignores an authority that is not EPSG', () => {
    const wkt = 'PROJCS["x",AUTHORITY["ESRI","102726"]]';

    expect(findHorizontalEpsgCode(wkt)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a system with no authority at all', 'PROJCS["x",UNIT["foot",0.3048]]'],
    ['a vertical system alone', 'VERT_CS["v",AUTHORITY["EPSG","6360"]]'],
    ['text that is not WKT', 'not wkt at all'],
  ])('returns null for %s', (_label, wkt) => {
    expect(findHorizontalEpsgCode(wkt)).toBeNull();
  });
});
