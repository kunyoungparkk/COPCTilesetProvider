import { describe, expect, it } from 'vitest';
import { CopcTilesetError, CrsCodeNotFoundError, CrsNotRegisteredError } from '../src/errors/index.js';
import { definitionFor, registerCrs } from '../src/crs/registry.js';

const OREGON = '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// The registry is process-wide module state by design, so these tests share it
// with each other and with every other test file — 2992 in particular is
// registered by the transform tests, because the pinned fixture's WKT names it.
// The default-table test therefore asks about a code nothing anywhere
// registers, so that it reads the same however vitest is isolating files.
describe('the CRS registry', () => {
  // Decision 6 registers exactly one system by default and makes everything
  // else the caller's business — one rule beats a partial built-in table.
  it('knows 4326 and nothing else out of the box', () => {
    // Pinned exactly, because this is the only definition the library ships
    // for reading a file's own coordinates: a parseable but wrong one here
    // would misplace every file that resolves through it, and nothing else in
    // the suite would see it. The one test that transforms through 4326
    // measures the distance between two points differing only in height — a
    // quantity identical wherever the horizontal pair lands. (transform.ts
    // holds a second copy of this string as its fixed WGS84 target. Nothing
    // pins that copy as a string — the corner test only requires it to agree
    // with WGS84 to within five metres at Autzen, which every ellipsoid-
    // compatible datum proj4 can apply without grids does.)
    expect(definitionFor(4326)).toBe('+proj=longlat +datum=WGS84 +no_defs');
    expect(definitionFor(32_633)).toBeUndefined();
  });

  it('resolves a code the caller registered', () => {
    registerCrs(2992, OREGON);

    expect(definitionFor(2992)).toBe(OREGON);
  });

  it('lets a caller replace a definition they registered earlier', () => {
    registerCrs(2992, OREGON);
    registerCrs(2992, '+proj=longlat +datum=NAD83 +no_defs');

    expect(definitionFor(2992)).toBe('+proj=longlat +datum=NAD83 +no_defs');
  });
});

describe('CrsNotRegisteredError', () => {
  it('hands back a registerCrs call the reader can paste', () => {
    const error = new CrsNotRegisteredError(2992);

    // Callers branch on the base type, so it is contract, not inheritance detail.
    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.name).toBe('CrsNotRegisteredError');
    expect(error.code).toBe('crs-not-registered');
    expect(error.epsgCode).toBe(2992);
    // Decision 6: the extracted code, inside a runnable call.
    expect(error.message).toContain('registerCrs(2992,');
    expect(error.message).toContain('epsg.io/2992');
  });
});

describe('CrsCodeNotFoundError', () => {
  it('points at the file rather than at the caller', () => {
    const error = new CrsCodeNotFoundError();

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.name).toBe('CrsCodeNotFoundError');
    expect(error.code).toBe('crs-code-not-found');
    // Nothing to register, because nothing was extracted — the file has to change.
    expect(error.message).not.toContain('registerCrs(');
    expect(error.message).toContain('pdal translate');
  });
});
