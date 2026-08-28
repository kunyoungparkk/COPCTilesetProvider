import { Info, Las } from 'copc';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Admission, Budget } from '../src/budget/index.js';
import { createBudget } from '../src/budget/index.js';
import { createCodec, createContentFactoryLoader } from '../src/cesium-runtime/codec.js';
import type { CodecContext } from '../src/cesium-runtime/codec.js';
import { ScheduledRangeResource } from '../src/cesium-runtime/resource.js';
import type { InterceptContext } from '../src/cesium-runtime/resource.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import type { CrsTransform } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { UnknownTileRequestError } from '../src/errors/index.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';
import type { TileEntry, TilesetContext } from '../src/tileset/index.js';
import type { DecodeHeader } from '../src/worker/index.js';
import { createWorkerPool } from '../src/worker/pool.js';
import type { WorkerPool } from '../src/worker/pool.js';
import { autzenWkt } from './autzen-wkt.js';
import { bufferReader } from './fake-reader.js';
import { FILE_URL, fixtureBytes as fixture } from './fixtures.js';
import { encodeHierarchyPage } from './hierarchy-page.js';
import { createNodeWorkerPort } from './worker-port-node.js';

const TOKEN_BASE = 'copc://a1b2c3/';

// Same proj4 definition tests/worker-pnts.test.ts and tests/worker-entry.test.ts
// register for EPSG:2992 — Autzen's own horizontal system, in international feet.
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const autzenCube = () =>
  Info.parse(fixture('autzen-head.bin').subarray(429, 429 + 160)).cube;

/** Autzen's real WKT resolved to a usable proj4 definition, and the transform built from it. */
async function crsSetup(): Promise<{ definition: string; transform: CrsTransform }> {
  registerCrs(2992, OREGON);
  const definition = resolveCrsDefinition(await autzenWkt());
  return { definition, transform: createTransformFromDefinition(definition) };
}

function tilesetContextFor(transform: CrsTransform): Omit<TilesetContext, 'rootKey'> {
  return {
    url: FILE_URL,
    tokenBase: TOKEN_BASE,
    cube: autzenCube(),
    // Same value tests/tileset-build.test.ts pins for this fixture.
    rootGeometricError: 88.709_699_234_182_7,
    transform,
  };
}

/** The pinned chunk (node 5-16-3-1): its hierarchy entry and the whole file's header. */
async function loadPointNode(): Promise<{ header: DecodeHeader; pointCount: number }> {
  const header = Las.Header.parse(fixture('autzen-head.bin').subarray(0, 375));
  const page = await readHierarchyPage(
    bufferReader(fixture('autzen-root-hierarchy.bin')),
    { offset: 0, length: fixture('autzen-root-hierarchy.bin').byteLength },
    header.pointCount,
  );
  const entry = page.nodes.find(
    (node) => node.key.depth === 5 && node.key.x === 16 && node.key.y === 3 && node.key.z === 1,
  );
  if (entry === undefined) {
    throw new Error('fixtures/autzen-root-hierarchy.bin no longer has node 5-16-3-1');
  }
  return {
    header: {
      pointDataRecordFormat: header.pointDataRecordFormat,
      pointDataRecordLength: header.pointDataRecordLength,
      scale: header.scale,
      offset: header.offset,
    },
    pointCount: entry.pointCount,
  };
}

/**
 * A minimal stand-in for `Cesium3DTile`, carrying only the two flags the
 * codec ever touches — started from Cesium's own real initial values for a
 * tile with a content URI (`Cesium3DTile.js:305` and `:337`:
 * `this.hasTilesetContent = false; ... this.hasRenderableContent =
 * !hasEmptyContent`, and every tile this codec is ever asked about has
 * content). Starting `hasRenderableContent` at `false` — its own default
 * only for a genuinely *empty* tile, which no codec-routed tile is — would
 * make a hierarchy tile's `tile.hasRenderableContent = false` assignment
 * untestable: the fake would already read `false` whether or not the codec
 * ever set it.
 */
function fakeTile(): { hasRenderableContent: boolean; hasTilesetContent: boolean } {
  return { hasRenderableContent: true, hasTilesetContent: false };
}

/**
 * A minimal stand-in for `Cesium3DTileset`, good enough for `makeModelOptions`
 * (Model3DTileContent.js) to read without throwing — measured directly against
 * the installed engine (no GL context, no browser) before this file was written.
 */
function fakeTileset(): Record<string, unknown> {
  return {
    _modelUpAxis: 0,
    _modelForwardAxis: 0,
    customShader: undefined,
    colorBlendMode: undefined,
    colorBlendAmount: 0.5,
    lightColor: undefined,
    imageBasedLighting: undefined,
    featureIdLabel: 'featureId_0',
    instanceFeatureIdLabel: 'instanceFeatureId_0',
    pointCloudShading: undefined,
    clippingPlanes: undefined,
    backFaceCulling: true,
    shadows: 1,
    showCreditsOnScreen: false,
    splitDirection: 0,
    _enableDebugWireframe: false,
    debugWireframe: false,
    _projectTo2D: false,
    _enablePick: true,
    _enableShowOutline: true,
    showOutline: true,
    outlineColor: undefined,
    statistics: {},
  };
}

/** `RuntimeContentCodec.createContent`'s `resource` param is typed `Resource`, but the codec reads only `.url`. */
function fakeResource(url: string): Parameters<ReturnType<typeof createCodec>['createContent']>[2] {
  return { url } as unknown as Parameters<ReturnType<typeof createCodec>['createContent']>[2];
}

function fakeBudget(admission: Admission): Budget {
  return {
    acquireRangeRequest: () => admission,
    acquireDecodeJob: () => {
      throw new Error('not exercised by this test');
    },
    stats: () => {
      throw new Error('not exercised by this test');
    },
    destroy: () => {
      /* not exercised by this test */
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a point tile', () => {
  // Measured (tests/worker-entry.test.ts's own comment): WASM init in a fresh
  // Worker is not instant. One real Worker is shared by every test in this
  // block, so only the first call pays that cost.
  const WORKER_TEST_TIMEOUT = 15_000;

  let workerPool: WorkerPool;
  let header: DecodeHeader;
  let pointCount: number;
  let transform: CrsTransform;
  let Model3DTileContent: new (...args: unknown[]) => unknown;

  beforeAll(async () => {
    ({ header, pointCount } = await loadPointNode());
    const crs = await crsSetup();
    transform = crs.transform;
    const budget = createBudget({ decodeJobs: 4 });
    workerPool = createWorkerPool({ spawn: createNodeWorkerPort, definition: crs.definition, budget, size: 1 });

    // Reached the house convention's way (tests/cesium-contract.test.ts): the
    // declared `cesium` peer's own runtime exports, not the undeclared
    // `@cesium/engine` package. Absent from `cesium`'s .d.ts, so a static
    // import fails typecheck (TS7016).
    ({ Model3DTileContent } = (await import('cesium')) as unknown as {
      Model3DTileContent: new (...args: unknown[]) => unknown;
    });
  }, WORKER_TEST_TIMEOUT);

  afterAll(() => {
    workerPool.destroy();
  });

  it(
    'is what Model3DTileContent.fromPnts produced, and marks the tile renderable',
    async () => {
      const entryUrl = `${TOKEN_BASE}n/5-16-3-1`;
      const entries = new Map<string, TileEntry>([
        [entryUrl, { kind: 'points', key: { depth: 5, x: 16, y: 3, z: 1 }, offset: 0, length: 0, pointCount }],
      ]);
      const context: CodecContext = {
        workerPool,
        header,
        filePointCount: 10_653_336,
        entries,
        tilesetContext: tilesetContextFor(transform),
        synthesizedAncestors: { count: 0 },
        hierarchyPagesExpanded: { count: 0 },
      };
      const codec = createCodec(context);
      const tile = fakeTile();

      const compressed = fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer;
      const content = await codec.createContent(fakeTileset(), tile, fakeResource(entryUrl), compressed);

      expect(content).toBeInstanceOf(Model3DTileContent);
      expect(tile.hasRenderableContent).toBe(true);
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    'branches on entry.kind, not the URI prefix: an "h/" URI carrying a points entry is still encoded as points',
    async () => {
      // Same entry as above, but registered under a hierarchy-shaped URI —
      // proves the branch reads `entry.kind`, which disagrees with the prefix
      // here on purpose.
      const entryUrl = `${TOKEN_BASE}h/5-16-3-1`;
      const entries = new Map<string, TileEntry>([
        [entryUrl, { kind: 'points', key: { depth: 5, x: 16, y: 3, z: 1 }, offset: 0, length: 0, pointCount }],
      ]);
      const context: CodecContext = {
        workerPool,
        header,
        filePointCount: 10_653_336,
        entries,
        tilesetContext: tilesetContextFor(transform),
        synthesizedAncestors: { count: 0 },
        hierarchyPagesExpanded: { count: 0 },
      };
      const codec = createCodec(context);
      const tile = fakeTile();

      const compressed = fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer;
      const content = await codec.createContent(fakeTileset(), tile, fakeResource(entryUrl), compressed);

      expect(content).toBeInstanceOf(Model3DTileContent);
      expect(tile.hasRenderableContent).toBe(true);
    },
    WORKER_TEST_TIMEOUT,
  );
});

describe('a hierarchy tile', () => {
  it('parses the page, re-enters buildTileset, grows the live registry, and marks the tile a tileset', async () => {
    const { transform } = await crsSetup();
    const hierEntryKey = { depth: 1, x: 0, y: 0, z: 0 };
    const hierUrl = `${TOKEN_BASE}h/1-0-0-0`;
    const newPointsUrl = `${TOKEN_BASE}n/2-0-0-0`;

    const entries = new Map<string, TileEntry>([
      [hierUrl, { kind: 'hierarchy', key: hierEntryKey, offset: 0, length: 0 }],
    ]);
    // Absent before the codec runs, so the assertion below on `grown` proves
    // the codec actually added it rather than it having been there all along.
    expect(entries.has(newPointsUrl)).toBe(false);

    const context: CodecContext = {
      workerPool: {
        encode: () => {
          throw new Error('a hierarchy tile must never reach the Worker pool');
        },
        encodeWhenAdmitted: () => {
          throw new Error('a hierarchy tile must never reach the Worker pool');
        },
        destroy: () => {
          /* unused */
        },
      },
      header: { pointDataRecordFormat: 7, pointDataRecordLength: 36, scale: [1, 1, 1], offset: [0, 0, 0] },
      filePointCount: 10_653_336,
      entries,
      tilesetContext: tilesetContextFor(transform),
      // Non-zero on purpose: proves the codec adds to a running total rather
      // than overwriting it with the sub-page's own count.
      synthesizedAncestors: { count: 3 },
      hierarchyPagesExpanded: { count: 0 },
    };
    const codec = createCodec(context);
    const tile = fakeTile();
    const tileset = { loadTileset: vi.fn() };

    // A page rooted one level under the hierarchy tile's own key, a single
    // points node — bytes only, no reader and no fetch: the codec is handed
    // these bytes already read (they arrived through `ScheduledRangeResource`),
    // so re-fetching them would be a second round trip for data already in hand.
    const pageBytes = encodeHierarchyPage([
      { key: [2, 0, 0, 0], offset: 5000, byteSize: 320, pointCount: 9 },
    ]);

    const { Tileset3DTileContent } = (await import('cesium')) as unknown as {
      Tileset3DTileContent: new (...args: unknown[]) => unknown;
    };

    const resourceContext: InterceptContext = {
      reader: bufferReader(new Uint8Array([1, 2, 3])),
      budget: fakeBudget({ verdict: 'admitted', lease: { release: () => {} } }),
      entries,
      tokenBase: TOKEN_BASE,
      url: FILE_URL,
    };
    const resource = new ScheduledRangeResource({ url: newPointsUrl }, resourceContext);

    const content = await codec.createContent(
      tileset,
      tile,
      fakeResource(hierUrl),
      pageBytes.buffer as ArrayBuffer,
    );

    // The sub-page's own single synthesized ancestor (its root, `2-0-0-0`'s
    // parent `1-0-0-0`, has no entry of its own) added to the pre-existing
    // total, not replacing it.
    expect(context.synthesizedAncestors.count).toBe(4);
    // One page expanded. Counted separately from the entries it contributed:
    // a page whose keys were all already known adds no entry at all, so
    // `registryEntries` could not stand in for this.
    expect(context.hierarchyPagesExpanded.count).toBe(1);

    expect(content).toBeInstanceOf(Tileset3DTileContent);
    expect(tile.hasTilesetContent).toBe(true);
    expect(tile.hasRenderableContent).toBe(false);
    expect(tileset.loadTileset).toHaveBeenCalledTimes(1);

    // `Tileset3DTileContent.fromJson` only ever calls
    // `tileset.loadTileset(resource, json, tile)` — a spy that only counts
    // calls proves nothing about what document was actually handed over, so
    // this inspects the JSON itself: a real 3D Tiles 1.0 document, ADD-refined
    // at its own root (Decision 6), whose one content-bearing tile is the
    // page's own points node under this provider's token scheme.
    const loadTilesetCall = tileset.loadTileset.mock.calls[0] as
      | [unknown, { asset: { version: string }; root: { refine?: string; children?: { content?: { uri: string } }[] } }, unknown]
      | undefined;
    if (loadTilesetCall === undefined) {
      throw new Error('expected tileset.loadTileset to have been called');
    }
    const [, json] = loadTilesetCall;
    expect(json.asset).toEqual({ version: '1.0' });
    expect(json.root.refine).toBe('ADD');
    expect(json.root.children?.[0]?.content?.uri).toBe(newPointsUrl);

    // The live registry gained the new page's own entry.
    const grown = entries.get(newPointsUrl);
    expect(grown).toEqual({
      kind: 'points',
      key: { depth: 2, x: 0, y: 0, z: 0 },
      offset: 5000,
      length: 320,
      pointCount: 9,
    });

    // `InterceptContext.entries` and `CodecContext.entries` are meant to be
    // the SAME live `Map`, not two copies of one — the codec adds to this
    // map as sub-pages open, and `ScheduledRangeResource` reads it back to
    // answer the next request for one of those new tiles. `resource` was
    // constructed above, before the codec ever ran, against this same
    // `entries` object; if either side had copied that object instead of
    // holding it by reference, `resource`'s own copy would still be frozen
    // at its construction-time contents — missing the entry the codec added
    // above — and this fetch would fail with `UnknownTileRequestError`
    // rather than resolving.
    await expect(resource.fetchArrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
  });
});

describe('an unknown entry', () => {
  it('raises a typed error rather than returning undefined', async () => {
    const { transform } = await crsSetup();
    const context: CodecContext = {
      workerPool: {
        encode: () => {
          throw new Error('unused');
        },
        encodeWhenAdmitted: () => {
          throw new Error('unused');
        },
        destroy: () => {
          /* unused */
        },
      },
      header: { pointDataRecordFormat: 7, pointDataRecordLength: 36, scale: [1, 1, 1], offset: [0, 0, 0] },
      filePointCount: 10_653_336,
      entries: new Map(),
      tilesetContext: tilesetContextFor(transform),
      synthesizedAncestors: { count: 0 },
      hierarchyPagesExpanded: { count: 0 },
    };
    const codec = createCodec(context);

    await expect(
      codec.createContent(fakeTileset(), fakeTile(), fakeResource(`${TOKEN_BASE}n/9-9-9-9`), new ArrayBuffer(0)),
    ).rejects.toBeInstanceOf(UnknownTileRequestError);
  });
});

describe('createContentFactoryLoader', () => {
  // A rejected promise is still a cached value to a bare `??=` — the failure
  // this guards against is a first `import('cesium')` (a code-split chunk
  // request, in a browser) failing once and poisoning every later tile
  // permanently, rather than leaving the next call free to try again.
  // Testing this against the real `cesium` peer would mean making a package
  // that is actually installed fail to import, which is not a fact about
  // this module's own caching policy — a substitutable `load` is the seam
  // that lets this be exercised directly, without mocking module resolution
  // at all. Each call builds its own loader with its own cache, so no test
  // can be poisoned by what another already resolved.
  it('a load() that fails once does not poison later calls: the next one tries again and can succeed', async () => {
    const load = vi.fn();
    load.mockRejectedValueOnce(new Error('chunk load failed'));
    load.mockResolvedValue({ Model3DTileContent: {}, Tileset3DTileContent: {} });

    const loadContentFactories = createContentFactoryLoader(load);

    await expect(loadContentFactories()).rejects.toThrow('chunk load failed');
    await expect(loadContentFactories()).resolves.toEqual({
      Model3DTileContent: {},
      Tileset3DTileContent: {},
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a successful load() is memoized: a second call does not call load() again', async () => {
    const load = vi.fn().mockResolvedValue({ Model3DTileContent: {}, Tileset3DTileContent: {} });

    const loadContentFactories = createContentFactoryLoader(load);

    await loadContentFactories();
    await loadContentFactories();

    expect(load).toHaveBeenCalledTimes(1);
  });
});
