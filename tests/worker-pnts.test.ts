import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { View } from 'copc';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileHeader } from '../src/copc/header.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { PositionCountMismatchError } from '../src/errors/index.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';
import { decodeChunk } from '../src/worker/decode.js';
import { encodePnts } from '../src/worker/pnts.js';
import type { RelativePositions } from '../src/worker/positions.js';
import { toRelativePositions } from '../src/worker/positions.js';
import { autzenWkt } from './autzen-wkt.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const URL_ = 'https://host/autzen.copc.laz';

/** A reader that serves one fixed buffer, regardless of the range asked for. */
function bufferReader(bytes: Uint8Array): RangeReader {
  return {
    url: URL_,
    read: (range: ByteRange) =>
      Promise.resolve({
        bytes: bytes.slice(range.offset, range.offset + range.length).buffer as ArrayBuffer,
        totalBytes: null,
      }),
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
}

// Same proj4 definition tests/crs-transform.test.ts and
// tests/worker-positions.test.ts register for EPSG:2992 — Autzen's own
// horizontal system, in international feet.
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Half a float32's relative spacing (2**-23 is the gap between 1 and the
// next representable float32) — the bound on one round-to-nearest error.
const FLOAT32_ROUNDING_BOUND = 2 ** -24;

/** Reads the raw PNTS header fields by hand, independent of PntsParser. */
function readPntsHeader(buffer: ArrayBuffer) {
  const dv = new DataView(buffer);
  const featureTableJsonByteLength = dv.getUint32(12, true);
  const featureTableBinaryByteLength = dv.getUint32(16, true);
  const batchTableJsonByteLength = dv.getUint32(20, true);
  const batchTableBinaryByteLength = dv.getUint32(24, true);
  const featureTableJsonStart = 28;
  const featureTableJson = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(buffer, featureTableJsonStart, featureTableJsonByteLength),
    ),
  ) as {
    POSITION: { byteOffset: number };
    RTC_CENTER: [number, number, number];
    POINTS_LENGTH: number;
  };
  const featureTableBinaryStart = featureTableJsonStart + featureTableJsonByteLength;
  const batchTableBinaryStart =
    featureTableBinaryStart + featureTableBinaryByteLength + batchTableJsonByteLength;
  return {
    version: dv.getUint32(4, true),
    byteLength: dv.getUint32(8, true),
    featureTableJsonByteLength,
    featureTableBinaryByteLength,
    batchTableJsonByteLength,
    batchTableBinaryByteLength,
    featureTableJson,
    featureTableBinaryStart,
    batchTableBinaryStart,
  };
}

/** How many trailing spaces `padTrailing` left on a JSON section. */
function trailingSpaces(buffer: ArrayBuffer, start: number, length: number): number {
  const bytes = new Uint8Array(buffer, start, length);
  let spaces = 0;
  while (spaces < length && bytes[length - 1 - spaces] === 0x20) spaces++;
  return spaces;
}

// Cesium's engine ships as @cesium/engine, but this project only declares a
// peer on `cesium` (OVERVIEW §5) — @cesium/engine is present solely as a
// transitive dependency of that peer. Reaching it the same way
// tests/cesium-contract.test.ts does: resolve it through the installed
// `cesium` package first, with an actionable error if it's missing, rather
// than importing an undeclared package name directly.
const resolveFrom = createRequire(import.meta.url);

/**
 * Dynamically imports one of Cesium's private engine modules (no .d.ts, so
 * a static import fails typecheck outright — TS7016 — even for modules that
 * do resolve at runtime). Resolving through `require.resolve` first, rather
 * than handing the specifier straight to `import()`, gives a clear error if
 * the peer dependency isn't installed instead of a bare "Cannot find
 * module." The resolved value is a variable, not a string literal, which is
 * what keeps TypeScript from attempting (and failing) to resolve this deep
 * path's declaration in the first place.
 */
async function importEngineModule<T>(path: string): Promise<T> {
  const specifier = `@cesium/engine/Source/${path}`;
  let resolved: string;
  try {
    resolved = resolveFrom.resolve(specifier);
  } catch {
    throw new Error(
      `Cannot resolve ${specifier}. This test needs Cesium's engine source; ` +
        'run `npm ci` to install the peer dependency before the suite.',
    );
  }
  return (await import(resolved)) as T;
}

/**
 * A minimal `View` good enough for `encodePnts`'s own contract: only the six
 * getters it actually reads (`view.dimensions` is never touched), each
 * returning one fixed value regardless of point index. Good for testing the
 * header/layout logic (byte counts, alignment, `BATCH_ID` sizing) in
 * isolation from any real LAS point format — not a stand-in for a real
 * decoded chunk, which the main `describe` above already covers.
 */
function syntheticView(count: number): View {
  return {
    pointCount: count,
    dimensions: {},
    getter: (name: string) => {
      const values: Record<string, number> = {
        Red: 256,
        Green: 512,
        Blue: 768,
        Classification: 2,
        Intensity: 100,
        GpsTime: 12345.5,
        ReturnNumber: 1,
        NumberOfReturns: 2,
      };
      const value = values[name];
      if (value === undefined) throw new Error(`No extractor for dimension: ${name}`);
      return () => value;
    },
  };
}

describe('encodePnts', () => {
  let pointCount: number;
  let buffer: ArrayBuffer;
  let ecef: [number, number, number][];
  let getRed: (index: number) => number;
  let getGreen: (index: number) => number;
  let getBlue: (index: number) => number;
  let getClassification: (index: number) => number;
  let getIntensity: (index: number) => number;
  let getGpsTime: (index: number) => number;
  let getReturnNumber: (index: number) => number;
  let getNumberOfReturns: (index: number) => number;
  let placedRtcCenter: [number, number, number];
  let placedPositions: Float32Array;

  beforeAll(async () => {
    // Same node tests/worker-decode.test.ts and tests/worker-positions.test.ts
    // decode: the file's smallest (47 points, LAS point format 7).
    const { header } = await readFileHeader(bufferReader(fixture('autzen-head.bin')));
    const page = await readHierarchyPage(
      bufferReader(fixture('autzen-root-hierarchy.bin')),
      { offset: 0, length: fixture('autzen-root-hierarchy.bin').byteLength },
      // Autzen's own header count (uint64 at byte 247 of fixtures/autzen-head.bin).
      10_653_336,
    );
    const entry = page.nodes.find(
      (node) => node.key.depth === 5 && node.key.x === 16 && node.key.y === 3 && node.key.z === 1,
    );
    if (entry === undefined) {
      throw new Error('fixtures/autzen-root-hierarchy.bin no longer has node 5-16-3-1');
    }
    const view = await decodeChunk(fixture('autzen-node-5-16-3-1.bin'), header, entry.pointCount);
    pointCount = view.pointCount;

    registerCrs(2992, OREGON);
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));

    const placed = toRelativePositions(view, transform);
    placedRtcCenter = placed.rtcCenter;
    placedPositions = placed.positions;

    buffer = encodePnts(view, placed);

    getRed = view.getter('Red');
    getGreen = view.getter('Green');
    getBlue = view.getter('Blue');
    getClassification = view.getter('Classification');
    getIntensity = view.getter('Intensity');
    getGpsTime = view.getter('GpsTime');
    getReturnNumber = view.getter('ReturnNumber');
    getNumberOfReturns = view.getter('NumberOfReturns');

    // Independent of both encodePnts and the parser below: the same
    // transform, called fresh, off the same file coordinates.
    const getX = view.getter('X');
    const getY = view.getter('Y');
    const getZ = view.getter('Z');
    ecef = [];
    for (let i = 0; i < view.pointCount; i++) {
      ecef.push(transform.toEcef(getX(i), getY(i), getZ(i)));
    }
  });

  it('property: rtcCenter + position reproduces the transform ECEF, to float32 resolution, hand-parsed', () => {
    // Parses the header, feature table JSON, and POSITION binary by hand —
    // no PntsParser involved — so a wrong byte offset, a missing alignment
    // pad, or an origin that does not match its relatives is caught even if
    // PntsParser itself were unavailable or wrong.
    const parsed = readPntsHeader(buffer);
    expect(parsed.version).toBe(1);
    expect(parsed.featureTableJson.POINTS_LENGTH).toBe(pointCount);

    const rtcCenter = parsed.featureTableJson.RTC_CENTER;
    const positionByteOffset =
      parsed.featureTableBinaryStart + parsed.featureTableJson.POSITION.byteOffset;
    const positions = new Float32Array(buffer, positionByteOffset, pointCount * 3);

    let maxAbsRelative = 0;
    for (let i = 0; i < pointCount * 3; i++) {
      maxAbsRelative = Math.max(maxAbsRelative, Math.abs(positions[i] ?? 0));
    }
    const tolerance = maxAbsRelative * FLOAT32_ROUNDING_BOUND;

    let worst = 0;
    for (let i = 0; i < pointCount; i++) {
      const expected = ecef[i] ?? [0, 0, 0];
      const rx = rtcCenter[0] + (positions[i * 3] ?? 0);
      const ry = rtcCenter[1] + (positions[i * 3 + 1] ?? 0);
      const rz = rtcCenter[2] + (positions[i * 3 + 2] ?? 0);
      worst = Math.max(
        worst,
        Math.abs(rx - expected[0]),
        Math.abs(ry - expected[1]),
        Math.abs(rz - expected[2]),
      );
    }
    expect(worst).toBeLessThanOrEqual(tolerance);
  });

  it('aligns every section boundary, and the tile itself, to 8 bytes', () => {
    // One rule, not two (POSITION used to need only 4): featureTableBinaryStart,
    // batchTableBinaryStart, and the tile's own declared byteLength all land
    // on an 8-byte boundary. Measured on this 47-point fixture (with
    // ReturnNumber and NumberOfReturns now in the batch table): the feature
    // table JSON still needs real padding (224 raw -> 228 padded, +4 bytes),
    // and the batch table binary still needs trailing zero bytes (611 raw ->
    // 616, +5) to bring the whole tile (2024 bytes) to a multiple of 8.
    //
    // The batch table JSON boundary is not exercised by this fixture: adding
    // the two new properties grew its raw length to 400 bytes, which already
    // lands on an 8-byte boundary at this JSON's position, so padTrailing
    // contributes 0 bytes here and a broken call at that site leaves this
    // assertion green. The scan over point counts below is what holds that
    // boundary, and it holds it without depending on any one count.
    const parsed = readPntsHeader(buffer);
    expect(parsed.featureTableBinaryStart % 8).toBe(0);
    expect(parsed.batchTableBinaryStart % 8).toBe(0);
    expect(parsed.byteLength % 8).toBe(0);
  });

  describe('Cesium reads back what we wrote (PntsParser.parse)', () => {
    // Cesium's own parsedContent shape is untyped (a plain JS module, no
    // .d.ts) — `any` here is reading Cesium's own runtime object, not a gap
    // in this codebase's types.
    let parsed: any;
    let ComponentDatatype: any;

    beforeAll(async () => {
      const { default: PntsParser } = await importEngineModule<{
        default: { parse: (buffer: ArrayBuffer) => any };
      }>('Scene/PntsParser.js');
      parsed = PntsParser.parse(buffer);

      // A public, declared-peer export — reached through `cesium` itself
      // (tests/cesium-contract.test.ts:99's own pattern), not through the
      // undeclared `@cesium/engine` transitive package.
      ({ ComponentDatatype } = (await import('cesium')) as unknown as {
        ComponentDatatype: any;
      });
    });

    it('reports the point count and RTC_CENTER', () => {
      expect(parsed.pointsLength).toBe(pointCount);
      // RTC_CENTER is written as plain JSON numbers (no byteOffset, so
      // Cesium reads it straight off the JSON rather than through a binary
      // accessor) and a finite double round-trips exactly through
      // JSON.stringify/JSON.parse — toBe, not toBeCloseTo, is the stronger
      // assertion and costs nothing.
      expect(parsed.rtcCenter.x).toBe(placedRtcCenter[0]);
      expect(parsed.rtcCenter.y).toBe(placedRtcCenter[1]);
      expect(parsed.rtcCenter.z).toBe(placedRtcCenter[2]);
    });

    it('reads back exactly the positions we wrote', () => {
      const positions: Float32Array = parsed.positions.typedArray;
      expect(positions.length).toBe(pointCount * 3);
      for (let i = 0; i < pointCount * 3; i++) {
        expect(positions[i]).toBe(placedPositions[i]);
      }
    });

    it('reads back RGB as the measured 8-bit value the 16-bit field actually carries', () => {
      // Measured on this fixture, every point, all three channels: Red/Green/
      // Blue are always exact multiples of 256 and never of 257 (e.g. Red
      // ranges 11520-17920, all %256 === 0). That means the file's real
      // colour precision is 8 bits already sitting in the high byte of a
      // 16-bit field, not a genuine 16-bit sample — so `>>> 8` recovers it
      // exactly, with no rounding, and without collapsing this fixture's
      // 45-70 Red range to black or white. (What this measurement does and
      // does not settle for other files is in encodePnts's own doc comment.)
      const colors: Uint8Array = parsed.colors.typedArray;
      expect(parsed.colors.componentDatatype).toBe(ComponentDatatype.UNSIGNED_BYTE);
      for (let i = 0; i < pointCount; i++) {
        expect(getRed(i) % 256).toBe(0);
        expect(getGreen(i) % 256).toBe(0);
        expect(getBlue(i) % 256).toBe(0);
        expect(colors[i * 3]).toBe(getRed(i) >>> 8);
        expect(colors[i * 3 + 1]).toBe(getGreen(i) >>> 8);
        expect(colors[i * 3 + 2]).toBe(getBlue(i) >>> 8);
      }
    });

    it('gives every point its own BATCH_ID, sized UNSIGNED_BYTE for 47 points', () => {
      // 47 <= 256, so the byte threshold applies (encodePnts's
      // batchIdComponentType); the short/int branches this fixture cannot
      // reach are pinned separately, below, against synthetic views.
      expect(parsed.batchIds.componentDatatype).toBe(ComponentDatatype.UNSIGNED_BYTE);
      expect(parsed.batchLength).toBe(pointCount);
      const batchIds: Uint8Array = parsed.batchIds.typedArray;
      for (let i = 0; i < pointCount; i++) {
        expect(batchIds[i]).toBe(i);
      }
    });

    it('transcodes the batch table as a property table (GpsTime survives as FLOAT64) — and would narrow to float32 without BATCH_ID', async () => {
      // PntsParser.parse alone never calls parseBatchTable (that only
      // happens in Model/PntsLoader.js's makeStructuralMetadata), so driving
      // it directly here is the only way to actually exercise the
      // DOUBLE -> FLOAT64 transcoding this module's doc comment rests on,
      // rather than re-asserting the componentType strings we wrote
      // ourselves into parsed.batchTableJson.
      const { default: parseBatchTable } = await importEngineModule<{
        default: (options: {
          count: number;
          batchTable: unknown;
          binaryBody?: Uint8Array;
          parseAsPropertyAttributes?: boolean;
          customAttributeOutput?: unknown[];
        }) => any;
      }>('Scene/parseBatchTable.js');

      // Positive control: BATCH_ID is present in every tile this module
      // emits, and PntsLoader.js:559's own fork
      // (`parseAsPropertyAttributes = !defined(parsedContent.batchIds)`)
      // always calls parseBatchTable with parseAsPropertyAttributes: false
      // on that path — drive that path directly on the parser's own output.
      const table = parseBatchTable({
        count: pointCount,
        batchTable: parsed.batchTableJson,
        binaryBody: parsed.batchTableBinary,
        parseAsPropertyAttributes: false,
      });
      const batchTableClassName = '_batchTable'; // MetadataClass.BATCH_TABLE_CLASS_NAME
      const classProperties = table.schema.classes[batchTableClassName].properties;
      expect(classProperties.GpsTime.componentType).toBe('FLOAT64');
      expect(classProperties.Intensity.componentType).toBe('UINT16');
      expect(classProperties.Classification.componentType).toBe('UINT8');
      expect(classProperties.ReturnNumber.componentType).toBe('UINT8');
      expect(classProperties.NumberOfReturns.componentType).toBe('UINT8');

      const propertyTable = table.getPropertyTable(0);
      for (let i = 0; i < pointCount; i++) {
        expect(propertyTable.getProperty(i, 'GpsTime')).toBe(getGpsTime(i));
        expect(propertyTable.getProperty(i, 'Intensity')).toBe(getIntensity(i));
        expect(propertyTable.getProperty(i, 'Classification')).toBe(getClassification(i));
        expect(propertyTable.getProperty(i, 'ReturnNumber')).toBe(getReturnNumber(i));
        expect(propertyTable.getProperty(i, 'NumberOfReturns')).toBe(getNumberOfReturns(i));
      }

      // Negative control: the exact same bytes, forced through the
      // property-*attributes* path that a tile without BATCH_ID would take.
      // This is the failure BATCH_ID's presence steers every shipped tile
      // away from, demonstrated on our own bytes rather than assumed from
      // reading parseBatchTable.js's source.
      const customAttributeOutput: { name: string; componentDatatype: number; typedArray: Float32Array }[] =
        [];
      parseBatchTable({
        count: pointCount,
        batchTable: parsed.batchTableJson,
        binaryBody: parsed.batchTableBinary,
        parseAsPropertyAttributes: true,
        customAttributeOutput,
      });
      const gpsAttribute = customAttributeOutput.find((attribute) => attribute.name === '_GPSTIME');
      expect(gpsAttribute).toBeDefined();
      expect(gpsAttribute?.componentDatatype).toBe(ComponentDatatype.FLOAT);
      // Cast to float32 and back loses precision — the cast value differs
      // from the double it started as, and matches nothing but Math.fround
      // of that double.
      expect(gpsAttribute?.typedArray[0]).toBe(Math.fround(getGpsTime(0)));
      expect(gpsAttribute?.typedArray[0]).not.toBe(getGpsTime(0));
    });
  });
});

describe('encodePnts on synthetic views (counts a 47-point fixture cannot reach)', () => {
  // Every boundary must stay exercised by *some* point count, whatever a
  // future property does to the section lengths. The 47-point fixture makes
  // the need concrete: adding ReturnNumber and NumberOfReturns grew its raw
  // batch table JSON to a length that already lands on an 8-byte boundary,
  // so padTrailing contributes nothing at that site and a broken call there
  // does not redden that fixture's own assertion. Pinning the rule to any
  // one count is pinning it to that count's arithmetic. This scans a range
  // instead: every count must come out aligned, and at least one count must
  // need real padding at each JSON boundary — so the coverage cannot quietly
  // evaporate the way it just did.
  it('keeps each 8-byte boundary exercised by some point count', () => {
    let featureTablePads = 0;
    let batchTablePads = 0;

    for (let count = 1; count <= 24; count++) {
      const buffer = encodePnts(syntheticView(count), {
        rtcCenter: [1, 2, 3],
        positions: new Float32Array(count * 3),
      });
      const parsed = readPntsHeader(buffer);
      expect(parsed.featureTableBinaryStart % 8).toBe(0);
      expect(parsed.batchTableBinaryStart % 8).toBe(0);
      expect(parsed.byteLength % 8).toBe(0);

      // padTrailing pads JSON with spaces, so the padding it added is
      // readable back off the tile without knowing the layout's arithmetic.
      if (trailingSpaces(buffer, 28, parsed.featureTableJsonByteLength) > 0) {
        featureTablePads++;
      }
      const batchTableJsonStart =
        parsed.featureTableBinaryStart + parsed.featureTableBinaryByteLength;
      if (trailingSpaces(buffer, batchTableJsonStart, parsed.batchTableJsonByteLength) > 0) {
        batchTablePads++;
      }
    }

    expect(featureTablePads).toBeGreaterThan(0);
    expect(batchTablePads).toBeGreaterThan(0);
  });

  it('a 1-point tile still aligns to 8 bytes and PntsParser still reads it back', async () => {
    // A count small enough that its own unpadded feature table JSON (170
    // bytes, measured) needs a different amount of padding (2 bytes, to
    // 172) than the real fixture above (4 bytes) — a second, independently
    // adversarial case for the same 8-byte rule, not a repeat of it.
    const view = syntheticView(1);
    const placed: RelativePositions = {
      rtcCenter: [1, 2, 3],
      positions: Float32Array.from([10, 20, 30]),
    };

    const buffer = encodePnts(view, placed);
    const parsed = readPntsHeader(buffer);
    expect(parsed.featureTableJson.POINTS_LENGTH).toBe(1);
    expect(parsed.featureTableBinaryStart % 8).toBe(0);
    expect(parsed.batchTableBinaryStart % 8).toBe(0);
    expect(parsed.byteLength % 8).toBe(0);

    const { default: PntsParser } = await importEngineModule<{
      default: { parse: (buffer: ArrayBuffer) => any };
    }>('Scene/PntsParser.js');
    const result = PntsParser.parse(buffer);
    expect(result.pointsLength).toBe(1);
    expect(result.positions.typedArray[0]).toBe(10);
    expect(result.colors.typedArray[0]).toBe(1); // Red 256 >>> 8 === 1
  });

  // The 47-point fixture above never leaves UNSIGNED_BYTE (47 <= 256), so it
  // cannot catch batchIdComponentType's threshold being wrong — mutating
  // `count <= 256` to `count <= 257` leaves every test above green. These
  // two pin the branches a real, larger COPC node would actually take.
  it.each([
    { count: 257, expected: 'UNSIGNED_SHORT' },
    { count: 65537, expected: 'UNSIGNED_INT' },
  ])('sizes BATCH_ID as $expected for $count points, with no id collision', async ({ count, expected }) => {
    const view = syntheticView(count);
    const placed: RelativePositions = { rtcCenter: [1, 2, 3], positions: new Float32Array(count * 3) };

    const buffer = encodePnts(view, placed);

    const { ComponentDatatype } = (await import('cesium')) as unknown as {
      ComponentDatatype: Record<string, number>;
    };
    const { default: PntsParser } = await importEngineModule<{
      default: { parse: (buffer: ArrayBuffer) => any };
    }>('Scene/PntsParser.js');
    const result = PntsParser.parse(buffer);

    expect(result.batchIds.componentDatatype).toBe(ComponentDatatype[expected]);
    // The actual harm a wrong threshold causes: two points sharing a batch
    // id, not merely "the wrong type name" — checked directly rather than
    // only checking the label.
    expect(new Set(result.batchIds.typedArray).size).toBe(count);
  });
});

describe('encodePnts refuses a placed.positions that does not match view.pointCount', () => {
  it('a 47-point view with a 10-point placed.positions is refused, not silently encoded', async () => {
    // Reproduced first, against the pre-fix encodePnts: this did not throw.
    // Every section size in the tile is derived from view.pointCount (47),
    // not from placed.positions.length (30, i.e. 10 points), so the tile
    // that comes out is internally consistent end to end — POINTS_LENGTH
    // and BATCH_LENGTH both 47, every header byte-length field correct —
    // and PntsParser.parse(buffer) does not throw either. It reads
    // POSITION as 47 * 12 = 564 bytes starting at byte 0 of a feature-table
    // binary sized for the real 308 (10 * 12 positions + 47 BATCH_ID + 47 *
    // 3 RGB), so 256 of those bytes are read from BATCH_ID, RGB, and the
    // start of the batch-table JSON that follows — measured directly:
    // parsed.positions.typedArray has length 141 (47 * 3), and only its
    // first 30 entries are the values this test actually wrote.
    const view = syntheticView(47);
    const placed: RelativePositions = {
      rtcCenter: [0, 0, 0],
      positions: new Float32Array(10 * 3).fill(1),
    };

    expect(() => encodePnts(view, placed)).toThrow(PositionCountMismatchError);
  });

  it('a matching count is unaffected', () => {
    // Guards against an overcorrection: the check must compare against
    // view.pointCount, not reject every synthetic view outright.
    const view = syntheticView(3);
    const placed: RelativePositions = { rtcCenter: [0, 0, 0], positions: new Float32Array(3 * 3) };

    expect(() => encodePnts(view, placed)).not.toThrow();
  });
});
