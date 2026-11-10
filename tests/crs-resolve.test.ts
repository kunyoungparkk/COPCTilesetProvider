import { describe, expect, it } from 'vitest';
import { autzenWkt } from './autzen-wkt.js';
import {
  HARTEBEESTHOEK94_LO15,
  KGD2002_CENTRAL_BELT,
  KOREAN_1985_MODIFIED_CENTRAL_BELT,
  VN2000_UTM_48N,
  WGS84_GEOGRAPHIC,
} from './epsg-wkt.js';
import { resolveCrsDefinition } from '../src/crs/index.js';
import { NULL_SHIFT_DATUMS } from '../src/crs/null-shift-datums.js';
import {
  CopcTilesetError,
  CrsCodeNotFoundError,
  CrsDefinitionRequiredError,
} from '../src/errors/index.js';

describe('resolveCrsDefinition against the real file', () => {
  it("answers with the file's horizontal system and nothing else", async () => {
    const definition = resolveCrsDefinition(await autzenWkt());

    // The whole compound makes proj4 throw, so only the PROJCS node may come
    // back — and it has to be the whole node, or proj4 reads a different
    // system. A string, so it can be posted to the Worker Decision 3 puts the
    // transform in.
    expect(definition.startsWith('PROJCS["NAD83 / Oregon GIC Lambert (ft)",')).toBe(true);
    expect(definition.endsWith('AUTHORITY["EPSG","2992"]]')).toBe(true);
    expect(definition).not.toContain('VERT_CS');
    expect(definition).not.toContain('COMPD_CS');
  });
});

describe('resolveCrsDefinition on systems a writer stores', () => {
  it('answers a geographic file with its GEOGCS', () => {
    expect(resolveCrsDefinition(WGS84_GEOGRAPHIC)).toBe(WGS84_GEOGRAPHIC);
  });

  it('answers a current Korean system without being told anything', () => {
    expect(resolveCrsDefinition(KGD2002_CENTRAL_BELT)).toBe(KGD2002_CENTRAL_BELT);
  });

  it('cuts the horizontal system out of a compound, whichever order it is in', () => {
    const vertical =
      'VERT_CS["EGM96 height",VERT_DATUM["EGM96 geoid",2005,AUTHORITY["EPSG","5171"]],' +
      'UNIT["metre",1],AUTHORITY["EPSG","5773"]]';

    expect(resolveCrsDefinition(`COMPD_CS["x",${KGD2002_CENTRAL_BELT},${vertical}]`)).toBe(
      KGD2002_CENTRAL_BELT,
    );
    expect(resolveCrsDefinition(`COMPD_CS["x",${vertical},${KGD2002_CENTRAL_BELT}]`)).toBe(
      KGD2002_CENTRAL_BELT,
    );
  });

  // Decision 6: no shift is a guess, and for Korean 1985 the guess is 379 m.
  it('refuses a datum EPSG publishes no zero shift for, naming the code and the fix', () => {
    const resolve = () => resolveCrsDefinition(KOREAN_1985_MODIFIED_CENTRAL_BELT);

    expect(resolve).toThrow(CrsDefinitionRequiredError);
    expect(resolve).toThrow(
      expect.objectContaining({ epsgCode: 5174, reason: 'datum-shift-unknown' }),
    );
    // Decision 6 promises the reader can select the indented line and run it.
    expect(resolve).toThrow("\n    COPCTilesetProvider.fromUrl(url, { crs: '");
    expect(resolve).toThrow('https://epsg.io/5174');
  });

  // The ellipsoid is not the test: VN-2000 is on WGS 84's own, and 225 m off.
  it('refuses an untrusted datum even on the WGS 84 ellipsoid', () => {
    expect(() => resolveCrsDefinition(VN2000_UTM_48N)).toThrow(
      expect.objectContaining({ epsgCode: 3405, reason: 'datum-shift-unknown' }),
    );
  });

  it('refuses a datum that carries no EPSG code at all', () => {
    const wkt = KGD2002_CENTRAL_BELT.replace(',AUTHORITY["EPSG","6737"]', '');

    expect(() => resolveCrsDefinition(wkt)).toThrow(
      expect.objectContaining({ epsgCode: 5186, reason: 'datum-shift-unknown' }),
    );
  });

  it("refuses a trusted datum whose WKT proj4 cannot read, rather than throwing proj4's own string", () => {
    expect(() => resolveCrsDefinition(HARTEBEESTHOEK94_LO15)).toThrow(
      expect.objectContaining({ epsgCode: 2046, reason: 'wkt-unreadable' }),
    );
  });
});

describe('resolveCrsDefinition when nothing names the system', () => {
  it('rejects a file whose WKT names no system', () => {
    expect(() => resolveCrsDefinition('PROJCS["x",UNIT["foot",0.3048]]')).toThrow(
      expect.objectContaining({ code: 'crs-code-not-found' }),
    );
  });
});

describe('NULL_SHIFT_DATUMS', () => {
  // A few members pinned by name, so a regenerated table that lost one of the
  // datums most files are on fails here rather than in a caller's error.
  it('holds WGS 84, NAD83 and its 2011 realization, ETRS89, KGD2002 and JGD2011', () => {
    for (const datum of [6326, 6269, 1116, 6258, 6737, 1128]) {
      expect(NULL_SHIFT_DATUMS.has(datum)).toBe(true);
    }
  });

  it('leaves out the datums measured far from WGS 84 with no shift applied', () => {
    // Korean 1985, VN-2000, DHDN, Amersfoort, OSGB 1936.
    for (const datum of [6162, 6756, 6314, 6289, 6277]) {
      expect(NULL_SHIFT_DATUMS.has(datum)).toBe(false);
    }
  });
});

describe('CrsDefinitionRequiredError', () => {
  it('is a library error with its code, the EPSG code, and the reason', () => {
    const error = new CrsDefinitionRequiredError(5174, 'wkt-unreadable');

    // Callers branch on the base type, so it is contract, not inheritance detail.
    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.name).toBe('CrsDefinitionRequiredError');
    expect(error.code).toBe('crs-definition-required');
    expect(error.epsgCode).toBe(5174);
    expect(error.reason).toBe('wkt-unreadable');
    expect(error.message).toContain("{ crs: '");
    expect(error.message).toContain('epsg.io/5174');
  });
});

describe('CrsCodeNotFoundError', () => {
  it('offers both fixes: the crs option, or a re-written file', () => {
    const error = new CrsCodeNotFoundError();

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.name).toBe('CrsCodeNotFoundError');
    expect(error.code).toBe('crs-code-not-found');
    expect(error.message).toContain("{ crs: '");
    expect(error.message).toContain('pdal translate');
  });
});
