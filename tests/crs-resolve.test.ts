import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

describe('resolveCrsDefinition against the real file', () => {
  it('answers with the definition registered for the code in the WKT', async () => {
    registerCrs(2992, OREGON);

    // The whole point of the split: what comes back is a string, so it can be
    // posted to the Worker that Decision 3 puts the transform in. A transform
    // is a closure and could not cross.
    expect(resolveCrsDefinition(await autzenWkt())).toBe(OREGON);
  });

  it('resolves the one system Decision 6 registers by default', () => {
    // Deliberately without a registerCrs call. Extraction meeting the default
    // seed is a path nothing else covers now that the transform tests take
    // their definitions literally.
    expect(resolveCrsDefinition('GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]')).toBe(
      '+proj=longlat +datum=WGS84 +no_defs',
    );
  });
});

describe('resolveCrsDefinition error paths', () => {
  it('names the code and how to register it', () => {
    const wkt = 'PROJCS["somewhere",AUTHORITY["EPSG","31370"]]';

    expect(() => resolveCrsDefinition(wkt)).toThrow(
      expect.objectContaining({ code: 'crs-not-registered', epsgCode: 31_370 }),
    );
    // Decision 6 promises the reader can select the indented line and run it,
    // so the call in the message has to be the form this barrel exports — a
    // bare `registerCrs`. Decision 6 also plans a static method on the
    // provider; the day that is what a caller can reach, this pin fails, which
    // is the only thing that will make the message change with it.
    expect(() => resolveCrsDefinition(wkt)).toThrow("\n    registerCrs(31370, '");
  });

  it('rejects a file whose WKT names no system', () => {
    expect(() => resolveCrsDefinition('PROJCS["x",UNIT["foot",0.3048]]')).toThrow(
      expect.objectContaining({ code: 'crs-code-not-found' }),
    );
  });

  it('rejects a file with no WKT at all', () => {
    expect(() => resolveCrsDefinition(undefined)).toThrow(
      expect.objectContaining({ code: 'crs-code-not-found' }),
    );
  });
});
