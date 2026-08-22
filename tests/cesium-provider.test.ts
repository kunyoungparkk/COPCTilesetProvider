import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';
import { Cesium3DTileset, Rectangle } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { COPCTilesetProvider, validateTokenBase } from '../src/cesium-runtime/provider.js';
import { ScheduledRangeResource } from '../src/cesium-runtime/resource.js';
import { counterForOrigin } from '../src/budget/host-registry.js';
import { resolveCrsDefinition } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import * as poolModule from '../src/worker/pool.js';
import type { WorkerPort } from '../src/worker/pool.js';
import { autzenWkt } from './autzen-wkt.js';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const FILE_URL = 'https://host/autzen.copc.laz';
const TOTAL_BYTES = 81_123_042;

// Same proj4 definition every other suite registers for Autzen's own
// horizontal system (EPSG:2992, international feet) — `tests/crs-transform.test.ts`,
// `tests/cesium-codec.test.ts`.
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// The pinned fixture's own root node (key 0-0-0-0), read directly out of
// `autzen-root-hierarchy.bin` before this file was written: 61,201 points at
// this offset/length. Real bytes are not needed to prove the request path —
// nothing here decodes them — so the fetch stub below serves this many zero
// bytes for it.
const ROOT_CHUNK = { offset: 79_462_688, length: 763_258 };

// Same pinned value `tests/tileset-build.test.ts` and `tests/tileset-geometric-error.test.ts`
// use for this fixture and this CRS.
const ROOT_GEOMETRIC_ERROR = 88.709_699_234_182_7;

const HEAD = load('autzen-head.bin');
const VLRS = load('autzen-vlrs.bin');
const ROOT_HIERARCHY = load('autzen-root-hierarchy.bin');
const HEADER = Las.Header.parse(HEAD.subarray(0, 375));

// Layout of `autzen-vlrs.bin`, pinned by `tests/copc-wkt.test.ts`: the info
// VLR (54 + 160), then a laszip VLR (54 + 46), then the WKT record — 314
// bytes in, a 54-byte header, then 993 content bytes with no padding.
const WKT_RECORD_START = 314;
const VLR_HEADER_LENGTH = 54;
const WKT_CONTENT_LENGTH = 993;

/**
 * Autzen's own VLR region, with the WKT record's content replaced and its
 * header bytes (userId, recordId, contentLength) reused verbatim — so the
 * file otherwise still parses exactly as Autzen's real one does, up to what
 * coordinate system it names.
 */
function vlrsWithWkt(content: string): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > WKT_CONTENT_LENGTH) {
    throw new Error('synthetic WKT longer than the pinned record can hold');
  }
  const region = new Uint8Array(VLRS);
  const contentStart = WKT_RECORD_START + VLR_HEADER_LENGTH;
  region.fill(0, contentStart, contentStart + WKT_CONTENT_LENGTH);
  region.set(bytes, contentStart);
  return region;
}

/** Serves a fixed set of byte ranges as 206 responses, and refuses anything else. */
function fixtureFetch(slices: readonly { offset: number; bytes: Uint8Array }[]) {
  const ranges: string[] = [];
  const fetch = ((_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get('range');
    ranges.push(range ?? '(none)');
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`expected a byte range header, got ${String(range)}`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    const slice = slices.find(
      (candidate) =>
        start >= candidate.offset && start + length <= candidate.offset + candidate.bytes.length,
    );
    if (slice === undefined) {
      throw new Error(`no fixture slice covers bytes ${start}-${end}`);
    }
    const from = start - slice.offset;
    const body = slice.bytes.slice(from, from + length);
    return Promise.resolve(
      new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${TOTAL_BYTES}` },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, ranges };
}

const autzenFetch = () =>
  fixtureFetch([
    { offset: 0, bytes: HEAD },
    { offset: 375, bytes: VLRS },
    { offset: 81_114_146, bytes: ROOT_HIERARCHY },
  ]);

const autzenFetchWithWkt = (wkt: string) =>
  fixtureFetch([
    { offset: 0, bytes: HEAD },
    { offset: 375, bytes: vlrsWithWkt(wkt) },
    { offset: 81_114_146, bytes: ROOT_HIERARCHY },
  ]);

/** Adds the root node's own chunk, so a tile fetch through the real tileset has somewhere to land. */
const autzenFetchWithRootChunk = () =>
  fixtureFetch([
    { offset: 0, bytes: HEAD },
    { offset: 375, bytes: VLRS },
    { offset: 81_114_146, bytes: ROOT_HIERARCHY },
    { offset: ROOT_CHUNK.offset, bytes: new Uint8Array(ROOT_CHUNK.length) },
  ]);

/** None of these tests ever admits a decode job, so a call here is a defect. */
const spawnWorker = (): WorkerPort => {
  throw new Error('spawnWorker should not be called by any test in this file');
};

/** A tile's content resource, reached the way `Cesium3DTile.js:278` sets it. */
function contentResourceOf(tile: unknown): unknown {
  return (tile as { _contentResource: unknown })._contentResource;
}

describe('COPCTilesetProvider.fromUrl', () => {
  it('issues exactly three requests before the tileset exists (§4)', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch, ranges } = autzenFetch();

    await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch });

    // Matches tests/copc-open.test.ts's own pin for this fixture exactly:
    // metadata (header + info VLR), the rest of the VLR region, the root
    // hierarchy page. Nothing else — no tile content is requested without a
    // render loop to drive traversal.
    expect(ranges).toEqual(['bytes=0-588', 'bytes=375-1735', 'bytes=81114146-81123041']);
  });

  it('rejects with CrsNotRegisteredError, carrying the code and a copy-pasteable registerCrs call', async () => {
    const wkt = 'PROJCS["somewhere",AUTHORITY["EPSG","88888"]]';

    await expect(
      COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch: autzenFetchWithWkt(wkt).fetch }),
    ).rejects.toMatchObject({ code: 'crs-not-registered', epsgCode: 88_888 });

    await expect(
      COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch: autzenFetchWithWkt(wkt).fetch }),
    ).rejects.toThrow("\n    registerCrs(88888, '");
  });

  it('rejects with CrsCodeNotFoundError when the WKT names no horizontal authority', async () => {
    const { fetch } = autzenFetchWithWkt('PROJCS["x",UNIT["foot",0.3048]]');

    await expect(
      COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch }),
    ).rejects.toMatchObject({ code: 'crs-code-not-found' });
  });

  it('refuses a relative url before issuing a single request', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch, ranges } = autzenFetch();

    // Measured before this check existed: all three bootstrap requests
    // succeeded and the call then died in `ScheduledRangeResource`'s
    // constructor with `TypeError: Invalid URL` — a message naming no file,
    // and in a browser carrying no `code` to branch on (Decision 6).
    await expect(
      COPCTilesetProvider.fromUrl('/data/autzen.copc.laz', { spawnWorker, fetch }),
    ).rejects.toMatchObject({ code: 'invalid-source-url', url: '/data/autzen.copc.laz' });

    // The point of checking at the entry rather than where the origin is
    // first needed: the failure costs nothing.
    expect(ranges).toEqual([]);

    // The url appears twice — named as the input, and again inside a call the
    // caller can paste as-is.
    await expect(
      COPCTilesetProvider.fromUrl('/data/autzen.copc.laz', { spawnWorker, fetch }),
    ).rejects.toThrow('new URL("/data/autzen.copc.laz", location.href).href');
  });

  it('gives two providers built from the same file different tokenBase values', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const one = await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch: autzenFetch().fetch });
    const other = await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch: autzenFetch().fetch });

    // The root's own content URI carries this provider's tokenBase. A
    // collision here is exactly what the registry-keying design warns about:
    // two tilesets whose registries would answer each other's requests.
    const oneUri = (contentResourceOf(one.tileset.root) as { url: string }).url;
    const otherUri = (contentResourceOf(other.tileset.root) as { url: string }).url;

    expect(oneUri).not.toBe(otherUri);
  });

  it('reaches the tileset through a ScheduledRangeResource, not a plain one', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch } = autzenFetch();

    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch });

    // This is the property the design's own measured section calls the
    // silent failure: a tileset built from the Blob URL as a bare string
    // gets a plain `Resource` for every tile, and `copc://…` would reach the
    // network. Asserting the class here is what would catch that mutation —
    // it fails faster than the composition test below and names the cause
    // more directly, so it stays even though that test subsumes it.
    expect(contentResourceOf(provider.tileset.root)).toBeInstanceOf(ScheduledRangeResource);
  });

  it('installs the codec on _runtimeContentCodec', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch } = autzenFetch();

    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch });

    // Decision 2's whole extension point. Nothing else in this suite reads
    // this field, so a dropped or misspelled assignment (`_notInstalled`,
    // say) would otherwise fail every tile at runtime with no test noticing.
    const codec = (provider.tileset as unknown as { _runtimeContentCodec?: { createContent?: unknown } })
      ._runtimeContentCodec;
    expect(typeof codec?.createContent).toBe('function');
  });

  it('fetches the root tile content through the real tileset, live registry, and shared budget', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch, ranges } = autzenFetchWithRootChunk();

    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch });

    // The root's own geometric error, from the file's measured span — a
    // construction mistake (a stray unit conversion, an unapplied divisor)
    // is invisible to an `instanceof` check but not to this number.
    expect(provider.tileset.root.geometricError).toBeCloseTo(ROOT_GEOMETRIC_ERROR, 9);

    const resource = contentResourceOf(provider.tileset.root) as ScheduledRangeResource;
    const bytes = await resource.fetchArrayBuffer();

    // Proves what `instanceof` cannot: the URI `buildTileset` minted for this
    // node is present in the *live* registry the resource actually holds,
    // the budget admitted the request, the reader turned it into a real
    // fourth Range read, and the bytes came back the right size.
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect((bytes as ArrayBuffer).byteLength).toBe(ROOT_CHUNK.length);
    expect(ranges).toEqual([
      'bytes=0-588',
      'bytes=375-1735',
      'bytes=81114146-81123041',
      `bytes=${ROOT_CHUNK.offset}-${ROOT_CHUNK.offset + ROOT_CHUNK.length - 1}`,
    ]);

    // Reads through `stats()`, not through the fetch above's own success —
    // if the interceptor and `stats()` were wired to two different `Budget`
    // instances, the fetch above would still have succeeded (its own budget
    // admitted it) while this would read back `0`.
    const stats = provider.stats();
    expect(stats.range.requests).toBe(4);
    expect(stats.budget.rangeBody.admitted).toBe(1);
    expect(stats.budget.hostRequests.admitted).toBe(1);
  });

  // The per-host slot registry is process-wide module state keyed by origin,
  // and the first call for an origin fixes its capacity. Claiming this file's
  // own origin at capacity 0 before the provider exists means the tile fetch
  // below can only be admitted if the interceptor asks about the *right*
  // origin — which is the one thing an `instanceof` check on the resource
  // cannot tell. A provider that derived its origin from anything else would
  // sail past a full host.
  it('admits a tile against the origin the file came from, not some other one', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch } = autzenFetchWithRootChunk();
    // Its own host, because the registry is keyed by origin and the first
    // call for one fixes its capacity for the whole process — another test
    // in this file has already claimed the shared one at §7's six.
    const url = 'https://full-host.example/autzen.copc.laz';
    counterForOrigin(new URL(url).origin, 0);

    const provider = await COPCTilesetProvider.fromUrl(url, { spawnWorker, fetch });
    const resource = contentResourceOf(provider.tileset.root) as ScheduledRangeResource;

    await expect(resource.fetchArrayBuffer()).rejects.toMatchObject({
      code: 'range-request-rejected',
    });
    expect(provider.stats().budget.hostRequests.rejected).toBe(1);
  });

  it('constructs Cesium3DTileset and the Worker pool with the options this design specifies', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);

    const tilesetSpy = vi.spyOn(Cesium3DTileset, 'fromUrl');
    const poolSpy = vi.spyOn(poolModule, 'createWorkerPool');
    try {
      await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch: autzenFetch().fetch });

      // Decision 1: ADD refinement carries full resolution at every depth
      // already, so `skipLevelOfDetail` stays at Cesium's own default.
      expect(tilesetSpy.mock.calls[0]?.[1]).toMatchObject({
        skipLevelOfDetail: false,
        maximumScreenSpaceError: 16,
      });
      // The resolved proj4 definition, not a WGS84 fallback — this is the
      // main-thread-resolution handoff Decision 3 exists to make; and §7's
      // default pool size, taken here rather than from `tileset` (which
      // knows nothing about the Worker pool at all).
      expect(poolSpy.mock.calls[0]?.[0]).toMatchObject({ definition: OREGON, size: 4 });
    } finally {
      tilesetSpy.mockRestore();
      poolSpy.mockRestore();
    }

    const tilesetSpy2 = vi.spyOn(Cesium3DTileset, 'fromUrl');
    const poolSpy2 = vi.spyOn(poolModule, 'createWorkerPool');
    try {
      await COPCTilesetProvider.fromUrl(FILE_URL, {
        spawnWorker,
        fetch: autzenFetch().fetch,
        maximumScreenSpaceError: 4,
        workerPoolSize: 2,
      });

      expect(tilesetSpy2.mock.calls[0]?.[1]).toMatchObject({ maximumScreenSpaceError: 4 });
      expect(poolSpy2.mock.calls[0]?.[0]).toMatchObject({ size: 2 });

      // OVERVIEW §7 sets the decode budget at pool size x 2, so it has to
      // follow the size this provider was given rather than staying at the
      // literal that happens to be right for the default pool of 4. A pool
      // throttled below the concurrency it was asked for is invisible from
      // `size` alone.
      const budget = poolSpy2.mock.calls[0]?.[0]?.budget;
      for (let job = 0; job < 4; job++) {
        expect(budget?.acquireDecodeJob().verdict).toBe('admitted');
      }
      expect(budget?.acquireDecodeJob().verdict).toBe('deferred');
    } finally {
      tilesetSpy2.mockRestore();
      poolSpy2.mockRestore();
    }
  });

  it("computes extent from the header's measured min/max, not the octree cube", async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch } = autzenFetch();

    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, { spawnWorker, fetch });

    // Independently derived from the same fixture's own header and the same
    // (separately verified, tests/crs-transform.test.ts) CRS transform,
    // rather than by calling anything provider.ts itself exports — so this
    // does not just check the implementation against itself.
    const transform = createTransformFromDefinition(resolveCrsDefinition(await autzenWkt()));
    const [minX, minY] = HEADER.min;
    const [maxX, maxY] = HEADER.max;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [x, y] of [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ] as const) {
      const [lon, lat] = transform.toWgs84(x, y, 0);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    const expected = Rectangle.fromDegrees(west, south, east, north);

    // 9 decimal places of a radian is sub-millimetre on the ground — tight
    // enough that the octree cube (§7's own padded, synthetic bounding
    // volume, hundreds of metres off on this fixture) cannot pass it by
    // accident.
    expect(provider.extent.west).toBeCloseTo(expected.west, 9);
    expect(provider.extent.south).toBeCloseTo(expected.south, 9);
    expect(provider.extent.east).toBeCloseTo(expected.east, 9);
    expect(provider.extent.north).toBeCloseTo(expected.north, 9);
  });

  it('passes a non-default maximumScreenSpaceError through to the tileset', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);

    // 4, not 16: §7's own default is also Cesium's own default
    // (`Cesium3DTileset.js`'s own `options.skipLevelOfDetail ?? false`-style
    // fallback), so asserting the default value alone cannot fail even
    // against an implementation that never forwards the option at all — the
    // spy-based test above checks that case instead, on the actual argument
    // this code constructs rather than on a coincidence of two defaults
    // agreeing.
    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, {
      spawnWorker,
      fetch: autzenFetch().fetch,
      maximumScreenSpaceError: 4,
    });

    expect(provider.tileset.maximumScreenSpaceError).toBe(4);
  });
});

describe('validateTokenBase', () => {
  it('accepts the shape the provider always generates', () => {
    expect(() => validateTokenBase('copc://a1b2c3/')).not.toThrow();
  });

  it('refuses a relative tokenBase', () => {
    expect(() => validateTokenBase('copc/a1b2c3/')).toThrow(
      expect.objectContaining({
        code: 'invalid-token-base',
        message: expect.stringContaining('must be an absolute URI with a scheme'),
      }),
    );
  });

  it('refuses a tokenBase missing its trailing "/"', () => {
    expect(() => validateTokenBase('copc://a1b2c3')).toThrow(
      expect.objectContaining({
        code: 'invalid-token-base',
        message: expect.stringContaining('must end with "/"'),
      }),
    );
  });

  it('refuses a tokenBase URI normalisation would rewrite', () => {
    // Absolute and trailing-slashed, so the two checks above both pass — and
    // still wrong, because the registry is keyed on the string handed in
    // while Cesium resolves content URIs through `getAbsoluteUri`, which
    // normalises. `%20` is what the space below becomes there, so every
    // lookup would miss.
    expect(() => validateTokenBase('copc://a1b2c3/x y/')).toThrow(
      expect.objectContaining({
        code: 'invalid-token-base',
        message: expect.stringContaining('"copc://a1b2c3/x%20y/"'),
      }),
    );
  });
});
