<img width="1280" height="649" alt="The Autzen stadium point cloud streamed onto Cesium World Terrain by HTTP Range request" src="https://github.com/user-attachments/assets/18d6bd12-5fce-4b57-859e-4be8a65d3478" />

# copc-tileset-provider

Stream static [COPC](https://copc.io/) point clouds into [CesiumJS](https://cesium.com/platform/cesiumjs/) — no pre-tiling, no backend, no conversion step.

[![CI](https://github.com/kunyoungparkk/COPCTilesetProvider/actions/workflows/ci.yml/badge.svg)](https://github.com/kunyoungparkk/COPCTilesetProvider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/copc-tileset-provider.svg)](https://www.npmjs.com/package/copc-tileset-provider)

A COPC file is a LAZ file whose points are already sorted into an octree. That
means the parts you need can be read with HTTP Range requests from any static
host — S3, nginx, GitHub Pages. This library streams that octree into Cesium as
a 3D Tiles tileset, so it loads, caches and styles like any other.

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

Cesium is a peer dependency, `>=1.142.0 <1.146.0`.

## Quick start

Register the file's coordinate system before opening it — see
[Coordinate systems](#coordinate-systems).

```js
import { Viewer } from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

// EPSG:2992 — Oregon Statewide Lambert, the system Autzen is stored in.
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

That URL is not a placeholder: it is the public Autzen scan, 81 MB, of which
opening the file reads about 10 KB.

`provider` is a Cesium primitive — `scene.primitives.add` takes it directly.

A complete, runnable example is in [`examples/`](examples/); it is the
screenshot at the top.

## Coordinate systems

Only **EPSG:4326** is known by default. Every other system has to be registered
once, before the file is opened:

```js
COPCTilesetProvider.registerCrs(2992, '<proj4 definition>');
```

The library reads the EPSG code out of the file's WKT and uses the definition
registered for it.

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

Every read is an HTTP Range request.

- **The host must serve `206`.** Most static hosts do; some CDNs and proxies
  strip Range support on compressed responses. A server that answers `200`
  with the whole file is refused.
- **If you host the file cross-origin**, also send
  `Access-Control-Expose-Headers: Content-Range`. Files load without it, but
  with it each response is checked against the exact byte range it claims.

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
| `GpsTime` | float32 | LAS GPS time |
| `ReturnNumber` | uint8 | LAS return number |
| `NumberOfReturns` | uint8 | LAS number of returns |

Unstyled, points take the file's own colour. LAS point format 6 carries none,
so such a file renders in Cesium's constant dark grey until a style gives it a
colour — every property above is still there to style on.

Picking resolves to a tile, not a single point: `scene.pick` cannot read one
point's properties.

## Limits

**Heights are ellipsoidal.** Every Z is height above the WGS84 ellipsoid.
Orthometric data — most surveyed LiDAR — sits at a visible vertical offset
until you pass the geoid separation at your dataset's location, in metres:

```js
await COPCTilesetProvider.fromUrl(url, { geoidHeight: -23.333 });
```

It is one constant for the whole file, so it suits a survey site, not a
continent. A file that declares a vertical CRS but gets no `geoidHeight` loads
with a console warning; pass `geoidHeight: 0` if its heights are already
ellipsoidal.

**Content is PNTS, which is 3D Tiles 1.0 legacy**, superseded by glTF-based
content in 3D Tiles 1.1. Chosen deliberately: a Worker can hand-encode PNTS — a
header, a feature table, a binary body — where glTF has to be assembled, and
its batch table is what gives Cesium's style language. glTF is on
the roadmap after v1.

**A strict `worker-src` CSP blocks the default Worker.** It loads from a
`blob:` URL. If your policy forbids `blob:`, supply your own Worker:

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

**A bundler that ignores `browser` fields will fail to build.** Vite and webpack
handle this by default, esbuild when its platform is `browser`, and plain Rollup
only with `@rollup/plugin-node-resolve` set to `{ browser: true }`. Otherwise
alias `laz-perf` to `laz-perf/lib/web/index.js`. Only Vite is tested.

## API

### `COPCTilesetProvider.fromUrl(url, options?)`

Opens the file and returns a provider, after reading only its metadata.

| Option | Default | What it does |
|---|---|---|
| `maximumScreenSpaceError` | `16` | Cesium's own quality knob, passed through. Lower means more tiles and more detail. |
| `workerPoolSize` | `4` | How many Workers decode in parallel. |
| `spawnWorker` | bundled Worker | Supply your own Worker, as a `WorkerPort`. See [Limits](#limits). |
| `fetch` | `globalThis.fetch` | Every Range request goes through this. Use it to add auth headers, sign URLs, or route through a proxy. |
| `signal` | — | Aborts `fromUrl` while it is still opening the file. |
| `geoidHeight` | — (HAE) | The geoid's separation from the WGS84 ellipsoid at this file's location, in metres, added to every height. Omit it for a file whose Z is already ellipsoidal. See [Limits](#limits). |

### Provider

| Member | Type | What it is |
|---|---|---|
| `tileset` | `Cesium3DTileset` | The live tileset. Styling, events and traversal settings go here. |
| `extent` | `Rectangle` | The file's extent, for camera framing. |
| `stats()` | `ProviderStats` | Request and loading counters, for diagnostics. |
| `destroy()` | `void` | Releases the tileset and its Workers. Safe to call more than once. |

### `COPCTilesetProvider.registerCrs(code, proj4Definition)`

Registers one coordinate system for every file opened afterwards.

### `browserPort(worker)`

Wraps a browser `Worker` as the `WorkerPort` that `spawnWorker` must return.

### `copc-tileset-provider/worker`

Import it in your own Worker module to use that Worker through `spawnWorker`.

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
