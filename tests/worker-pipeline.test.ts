import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileHeader } from '../src/copc/header.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import { ZeroPointChunkError } from '../src/errors/index.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';
import type { DecodeHeader } from '../src/worker/decode.js';
import { encodeNode } from '../src/worker/pipeline.js';
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

// Same proj4 definition tests/crs-transform.test.ts, tests/worker-positions.test.ts,
// and tests/worker-pnts.test.ts register for EPSG:2992 — Autzen's own
// horizontal system, in international feet.
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Cesium's engine ships as @cesium/engine, but this project only declares a
// peer on `cesium` (OVERVIEW §5) — @cesium/engine is present solely as a
// transitive dependency of that peer. Reaching it the same way
// tests/worker-pnts.test.ts does: resolve it through the installed `cesium`
// package first, with an actionable error if it's missing, rather than
// importing an undeclared package name directly.
const resolveFrom = createRequire(import.meta.url);

/**
 * Dynamically imports one of Cesium's private engine modules (no .d.ts, so
 * a static import fails typecheck outright — TS7016 — even for modules that
 * do resolve at runtime).
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

/** The RTC_CENTER a PNTS buffer declares, read out of its feature table JSON. */
function rtcCenterOf(pnts: ArrayBuffer): [number, number, number] {
  const view = new DataView(pnts);
  const jsonLength = view.getUint32(12, true);
  const json = new TextDecoder().decode(new Uint8Array(pnts, 28, jsonLength));
  return JSON.parse(json).RTC_CENTER;
}

describe('encodeNode', () => {
  let header: DecodeHeader;
  let compressed: Uint8Array;
  let pointCount: number;
  let definition: string;

  beforeAll(async () => {
    // Same node tests/worker-decode.test.ts, tests/worker-positions.test.ts,
    // and tests/worker-pnts.test.ts decode: the file's smallest (47 points,
    // LAS point format 7).
    ({ header } = await readFileHeader(bufferReader(fixture('autzen-head.bin'))));
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
    compressed = fixture('autzen-node-5-16-3-1.bin');
    pointCount = entry.pointCount;

    registerCrs(2992, OREGON);
    definition = resolveCrsDefinition(await autzenWkt());
  });

  it('goes end to end: the real chunk produces a buffer PntsParser reads back as 47 points', async () => {
    const buffer = await encodeNode({ compressed, header, pointCount, definition });

    const { default: PntsParser } = await importEngineModule<{
      default: { parse: (buffer: ArrayBuffer) => { pointsLength: number } };
    }>('Scene/PntsParser.js');
    const parsed = PntsParser.parse(buffer);
    expect(parsed.pointsLength).toBe(47);
  });

  it('raises a typed error rather than producing a buffer for a zero-point chunk', async () => {
    await expect(
      encodeNode({ compressed: new Uint8Array(0), header, pointCount: 0, definition }),
    ).rejects.toBeInstanceOf(ZeroPointChunkError);
  });

  it('carries the geoid height into the positions it encodes', async () => {
    const plain = await encodeNode({ compressed, header, pointCount, definition });
    const lowered = await encodeNode({
      compressed,
      header,
      pointCount,
      definition,
      geoidHeight: -23.333,
    });

    // PNTS RTC_CENTER is the midpoint of the transformed points' ECEF box, so a
    // vertical datum shift moves it and nothing else about the tile changes.
    expect(rtcCenterOf(lowered)).not.toEqual(rtcCenterOf(plain));
    expect(Math.hypot(...rtcCenterOf(lowered))).toBeLessThan(Math.hypot(...rtcCenterOf(plain)));
    expect(lowered.byteLength).toBe(plain.byteLength);
  });
});
