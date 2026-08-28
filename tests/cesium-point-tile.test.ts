import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cartesian3, Rectangle } from 'cesium';
import type { Resource } from 'cesium';
import { COPCTilesetProvider } from '../src/cesium-runtime/provider.js';
import { fixtureBytes as fixture, fixtureFetch } from './fixtures.js';
import { createNodeWorkerPort } from './worker-port-node.js';

/**
 * One point tile, all the way through the composition `fromUrl` builds: a
 * real Worker spawned by the option a caller passes, the real Autzen chunk
 * fetched through the provider's own `ScheduledRangeResource` and budget, and
 * the codec `fromUrl` installed turning those bytes into Cesium content.
 *
 * Every other test in this repository exercises one of those pieces against a
 * stand-in for the rest. Nothing else pins how `fromUrl` wires the file's
 * `header`, its point count and the resolved CRS definition into the pool —
 * all three are read inside the Worker, on the far side of a structured
 * clone, so a mis-wiring is invisible until a chunk is actually decoded.
 */

// Same proj4 definition every other suite registers for Autzen's own
// horizontal system (EPSG:2992, international feet).
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const FILE_URL = 'https://point-tile-host.example/autzen.copc.laz';

// Node 5-16-3-1's own chunk, at the offset and length the pinned root
// hierarchy page declares for it — the file's smallest node, 47 points, and
// the one `fixtures/autzen-node-5-16-3-1.bin` holds the real bytes of.
const NODE_KEY = '5-16-3-1';
const NODE_CHUNK = { offset: 53_565_789, length: 951 };
const NODE_POINTS = 47;

const autzenFetch = (): typeof globalThis.fetch =>
  fixtureFetch([
    { offset: 0, bytes: fixture('autzen-head.bin') },
    { offset: 375, bytes: fixture('autzen-vlrs.bin') },
    { offset: 81_114_146, bytes: fixture('autzen-root-hierarchy.bin') },
    { offset: NODE_CHUNK.offset, bytes: fixture(`autzen-node-${NODE_KEY}.bin`) },
  ]).fetch;

// The pinned Autzen fixture's WKT declares vertical CRS EPSG:6360, and
// `fromUrl` here is never given a `geoidHeight` — correct behaviour (tested
// in tests/cesium-provider.test.ts), but noise in a file about the point-tile
// pipeline, not the warning.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('a point tile through the composition fromUrl builds', () => {
  it('spawns a real Worker, decodes the pinned chunk, and returns Cesium point content', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, {
      spawnWorker: createNodeWorkerPort,
      fetch: autzenFetch(),
    });

    // Node has no render loop, so nothing here can make Cesium's traversal
    // pick this tile. The URI is derived from the root's own content
    // resource instead — same `tokenBase`, same `n/` shape `buildTileset`
    // emits — and cloned, which is what a real traversal would hand
    // `fetchArrayBuffer` too.
    const rootResource = (provider.tileset.root as unknown as { _contentResource: Resource })
      ._contentResource;
    const nodeResource = rootResource.clone();
    nodeResource.url = `${rootResource.url.slice(0, -'n/0-0-0-0'.length)}n/${NODE_KEY}`;

    const compressed = await nodeResource.fetchArrayBuffer();
    // The registry's own entry for this node decided the range, so this
    // length is the hierarchy page's declared byteSize, not a number this
    // test chose.
    expect(compressed?.byteLength).toBe(NODE_CHUNK.length);

    const codec = (
      provider.tileset as unknown as {
        _runtimeContentCodec: {
          createContent: (...args: unknown[]) => Promise<{ constructor: { name: string } }>;
        };
      }
    )._runtimeContentCodec;
    // A real `Cesium3DTile` reaches the codec with `hasTilesetContent` already
    // `false` (`Cesium3DTile.js:305`) and `hasRenderableContent` already
    // `true` for any tile that has a content URI (`:337`,
    // `!hasEmptyContent`). `hasRenderableContent` starts inverted here so the
    // assertion below cannot pass on an untouched object; `hasTilesetContent`
    // starts where Cesium leaves it, because the point branch does not write
    // it and inverting it would assert a behaviour the codec does not have.
    const tile = { hasRenderableContent: false, hasTilesetContent: false };

    const content = await codec.createContent({}, tile, nodeResource, compressed);

    expect(content.constructor.name).toBe('Model3DTileContent');
    expect(tile).toEqual({ hasRenderableContent: true, hasTilesetContent: false });
    // 47 points reached the far side of the Worker boundary and came back as
    // features: the header, point count and CRS definition `fromUrl` wired
    // into the pool were all the right ones.
    // Read off the loader rather than `content.pointsLength`, which stays 0
    // until the model builds its feature tables — that needs a WebGL context,
    // and Node has none. `PntsLoader._parsedContent` is what Cesium's own
    // `PntsParser` produced from the bytes the Worker sent back, which is the
    // furthest this environment can follow them.
    const parsed = (
      content as unknown as {
        _model: { _loader: { _parsedContent: { pointsLength: number; rtcCenter: Cartesian3 } } };
      }
    )._model._loader._parsedContent;

    // 47 points survived the round trip: the file `header` `fromUrl` wired
    // into the pool was the right one, and so was the `pointCount` the
    // registry's entry carried.
    expect(parsed.pointsLength).toBe(NODE_POINTS);

    // Decision 6's RTC_CENTER, and the only check here that the CRS
    // definition reached the Worker realm at all: this node's centre lands
    // inside the extent `fromUrl` computed on the main thread from the same
    // header and the same transform. A wrong scale/offset or a different
    // coordinate system puts it nowhere near. Autzen's whole extent is under
    // 2 km across, so 5 km is loose enough not to depend on which node this
    // is and far tighter than any mis-wiring would land.
    const extentCentre = Cartesian3.fromRadians(
      Rectangle.center(provider.extent).longitude,
      Rectangle.center(provider.extent).latitude,
    );
    expect(Cartesian3.distance(parsed.rtcCenter, extentCentre)).toBeLessThan(5000);

    // Decision 5: the decode job was admitted once and its lease returned, on
    // a path that ended in success.
    expect(provider.stats().budget.decode).toMatchObject({
      admitted: 1,
      deferred: 0,
      rejected: 0,
      inUse: 0,
    });

    provider.destroy();
  }, 30_000);
});
