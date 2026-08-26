<img width="1280" height="649" alt="The Autzen stadium point cloud streamed onto Cesium World Terrain by HTTP Range request" src="https://github.com/user-attachments/assets/18d6bd12-5fce-4b57-859e-4be8a65d3478" />

# copc-tileset-provider

Stream static [COPC](https://copc.io/) point clouds into [CesiumJS](https://cesium.com/platform/cesiumjs/) — no pre-tiling, no backend, no conversion step.

[![CI](https://github.com/kunyoungparkk/COPCTilesetProvider/actions/workflows/ci.yml/badge.svg)](https://github.com/kunyoungparkk/COPCTilesetProvider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/copc-tileset-provider.svg)](https://www.npmjs.com/package/copc-tileset-provider)

A COPC file is a LAZ file whose points are already sorted into an octree. That
means the parts you need can be read with HTTP Range requests from any static
host — S3, nginx, GitHub Pages. This library maps that octree onto Cesium's own
3D Tiles engine as it loads, so traversal, level of detail, request priority,
caching, styling and picking all stay Cesium's.

Point it at a URL and it renders:

```js
COPCTilesetProvider.registerCrs(2992, '+proj=lcc +lat_0=41.75 +lon_0=-120.5 …');

const provider = await COPCTilesetProvider.fromUrl(
  'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
);
viewer.scene.primitives.add(provider);
viewer.camera.flyTo({ destination: provider.extent });
```

## Install

```sh
npm install copc-tileset-provider cesium
```

`0.x` on purpose: every release is packed, installed into a throwaway project
and rendered in headless Chromium, but nobody outside this repository has lived
with the API yet, so it may still move. What moved, and what it means for code
you have already written, is in [CHANGELOG.md](CHANGELOG.md) — behaviour
changes are called out as such.

Cesium is a peer dependency, `>=1.142.0 <1.145.0`. Both ends of that range are
rendered in a real browser before it is widened.

## Quick start

Register the file's coordinate system first, then open it. That order is not
incidental — see [Coordinate systems](#coordinate-systems).

```js
import { Viewer } from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

// EPSG:2992 — Oregon Statewide Lambert, the system Autzen is stored in.
// Any system other than EPSG:4326 has to be registered once, before use.
COPCTilesetProvider.registerCrs(
  2992,
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
    '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs',
);

const viewer = new Viewer('cesiumContainer');

const provider = await COPCTilesetProvider.fromUrl(
  'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
);

viewer.scene.primitives.add(provider);
viewer.camera.flyTo({ destination: provider.extent });
```

That URL is real — the public Autzen stadium scan, 81 MB, streamed a few
hundred kilobytes at a time. Paste the block and it renders.

`provider` is a Cesium primitive: `scene.primitives.add` takes it directly, and
`provider.destroy()` releases the tileset, the Worker pool and every outstanding
reservation.

A complete, runnable example is in [`examples/`](examples/) — that is the
demo above.

## Coordinate systems

Only **EPSG:4326** is known by default. Every other system has to be registered
once, before the file is opened:

```js
COPCTilesetProvider.registerCrs(2992, '<proj4 definition>');
```

The library reads the EPSG code out of the file's WKT and looks it up. It does
**not** feed the WKT to proj4 directly: proj4 either throws on some dialects
(measured, on Autzen's compound WKT) or silently produces wrong coordinates when
datum information is missing, and there is no way to tell which in advance. A
registered definition is the only input somebody has vouched for.

An unregistered system fails with an error that names it and hands you the call
to paste, including where to find the definition:

```
This file uses EPSG:2992, which is not registered. […]

    registerCrs(2992, '<proj4 definition>');

The definition for EPSG:2992 is at https://epsg.io/2992 […]
```

A registered definition's accuracy is the registrant's; this library applies
what it is given.

## Your server has to support Range requests

Every read is an HTTP Range request, and every response is verified: a `206`
whose `Content-Range` matches what was asked for. **There is no fall back to
downloading the whole file** — a fallback would quietly turn streaming into a
full-file download, which is the thing this library exists to avoid.

Two consequences worth checking before you file a bug:

- **The host must serve `206`.** Most static hosts do. Some CDNs and proxies
  strip Range support on compressed responses. A `200` is refused outright —
  that is the whole file, and accepting it is the failure this rule exists to
  prevent.
- **Cross-origin, verification is one notch weaker, and that is expected.**
  Browsers hand JavaScript only the CORS-safelisted response headers, and
  `Content-Range` is not one of them unless the server sends
  `Access-Control-Expose-Headers: Content-Range` — which no public COPC dataset
  does. When the header is readable, the range is checked against it exactly.
  When it is not, the response is accepted on its status and the exact length
  of its body; what cannot then be confirmed is *which* bytes came back. Send
  the header if you control the host and want the stronger check.

## Styling and picking

Tiles are standard Cesium content, so the engine's own tools work unchanged:

```js
import { Cesium3DTileStyle } from 'cesium';

provider.tileset.style = new Cesium3DTileStyle({
  color: "${Classification} === 2 ? color('brown') : color('green')",
  show: '${Intensity} > 30',
});
```

Each point carries these batch-table properties:

| Property | Type | From |
|---|---|---|
| `Classification` | uint8 | LAS classification |
| `Intensity` | uint16 | LAS intensity |
| `GpsTime` | float64 | LAS GPS time |
| `ReturnNumber` | uint8 | LAS return number |
| `NumberOfReturns` | uint8 | LAS number of returns |

Picking goes through Cesium's own `scene.pick`. Every point is encoded with a
`BATCH_ID`, which is what lets a picked point carry the properties above —
without it Cesium builds no feature table and there is nothing to read.

## Limits

Read this section before deciding whether the library fits.

**Point formats 6, 7 and 8 — the three COPC allows.** Any other format is
plain LAS or LAZ rather than COPC, whatever the file is named, and `fromUrl`
refuses it with the format named and the conversion to run. Points take the
file's own colour, which format 6 does not carry: those tiles arrive uncoloured
and Cesium draws them in its constant dark grey until a style gives them a
colour. Everything else is unaffected — the batch-table properties below are
all present, so [styling and picking](#styling-and-picking) work the same.

**Heights are ellipsoidal.** Every Z is height above the WGS84 ellipsoid.
Orthometric data — most surveyed LiDAR — sits at a visible vertical offset
until you pass the geoid separation at your dataset's location, in metres:

```js
await COPCTilesetProvider.fromUrl(url, { geoidHeight: -23.333 });
```

One constant for the whole file, so it holds where the separation does not vary
— a survey site, not a continent. Grid-based correction is out of scope for v1.
A file that declares a vertical CRS and gets no `geoidHeight` loads anyway, with
a console warning naming the code. That check cannot tell an already-ellipsoidal
vertical CRS from a geoid-referenced one, so pass `geoidHeight: 0` to silence
it rather than omitting the option.

**Content is PNTS, which is 3D Tiles 1.0 legacy**, superseded by glTF-based
content in 3D Tiles 1.1. Chosen deliberately: a Worker can hand-encode PNTS — a
header, a feature table, a binary body — far more simply than it can assemble
glTF, and its batch table is what gives Cesium's style language and picking for
free. glTF is on the roadmap after v1.

**The default Worker comes from a `blob:` URL**, built from a bundle inlined
into the library so nothing has to be served or configured. A Content Security
Policy forbidding `worker-src blob:` blocks it, and the library cannot work
around that. Supply your own Worker instead:

```js
// 1. Your own Worker module — the subpath installs itself when evaluated.
//    your-worker.js:
import 'copc-tileset-provider/worker';

//    and where you build the provider:
import { browserPort } from 'copc-tileset-provider';

await COPCTilesetProvider.fromUrl(url, {
  spawnWorker: () =>
    browserPort(new Worker(new URL('./your-worker.js', import.meta.url), { type: 'module' })),
});
```

**A bundler that ignores `browser` fields will fail to build.** Your bundler
resolves `laz-perf` itself, and what keeps it off laz-perf's Node build — which
reaches for `require("fs")` — is that package's own
`"browser": "lib/web/index.js"`. Vite and webpack honour it by default, esbuild
when its platform is `browser`, plain Rollup only with
`@rollup/plugin-node-resolve` set to `{ browser: true }`. Otherwise alias
`laz-perf` to `laz-perf/lib/web/index.js`. Only the Vite path is measured — the
publish smoke builds with it.

**Also out of scope for v1:** writing or editing COPC, plain LAS/LAZ files, an
exact global point budget, WebGL 1, and 2D or Columbus View.

Cesium 1.141 and earlier is not a choice: the `_runtimeContentCodec` slot this
library installs onto arrived in 1.142, so on anything older the mechanism it
depends on does not exist.

## API

### `COPCTilesetProvider.fromUrl(url, options?)`

Opens the file and returns a provider. Reads metadata and the root hierarchy
page — three Range requests — before resolving.

| Option | Default | What it does |
|---|---|---|
| `maximumScreenSpaceError` | `16` | Cesium's own quality knob, passed through. Lower means more tiles and more detail. |
| `workerPoolSize` | `4` | How many Workers decode in parallel. |
| `spawnWorker` | bundled Worker | Supply your own Worker, as a `WorkerPort`. See [Limits](#limits). |
| `fetch` | `globalThis.fetch` | Every Range request goes through this. Use it to add auth headers, sign URLs, or route through a proxy. |
| `signal` | — | Aborts the three reads `fromUrl` makes. Tile requests are cancelled by Cesium itself. |
| `geoidHeight` | — (HAE) | The geoid's separation from the WGS84 ellipsoid at this file's location, in metres, added to every height. Omit it for a file whose Z is already ellipsoidal. See [Limits](#limits). |

### Provider

| Member | Type | What it is |
|---|---|---|
| `tileset` | `Cesium3DTileset` | The live tileset. Styling, events and traversal settings go here. |
| `extent` | `Rectangle` | The file's measured extent, for camera framing. Not the inflated tile bounds. |
| `stats()` | `ProviderStats` | Range counters, budget admissions, and registry size. |
| `destroy()` | `void` | Releases the tileset, the Workers and every reservation. Idempotent. |

### `COPCTilesetProvider.registerCrs(code, proj4Definition)`

Teaches this process one coordinate system. Static, because it has to be
callable before any file is opened.

### `browserPort(worker)`

Wraps a browser `Worker` as the `WorkerPort` that `spawnWorker` must return.

### `copc-tileset-provider/worker`

The Worker realm's entry point. Importing it inside a Worker installs the
message handler; it does not reach Cesium.

### Errors

Every failure is a typed class exported from the package root, each carrying a
`code` and a message that names the fix. Catch `CopcTilesetError` for all of
them, or a specific class for one.

## Contributing

How to run the suite, what review looks for, and how a release is cut:
[CONTRIBUTING.md](CONTRIBUTING.md). How the pieces fit together:
[docs/architecture.md](docs/architecture.md). The decisions behind them, with
their reasoning and measurements: [OVERVIEW.md](OVERVIEW.md) (Korean).

## License

MIT. See [LICENSE](LICENSE). The published bundles inline their dependencies,
whose licenses are reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
