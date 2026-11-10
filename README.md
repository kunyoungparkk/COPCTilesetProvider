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

Cesium is a peer dependency, `>=1.142.0 <1.148.0`.

## Quick start

```js
import { Viewer } from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

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

The file says which coordinate system its points are in, and the library reads
it from there. A file on WGS 84, NAD83, ETRS89, GDA2020, KGD2002, JGD2011, or
any other datum EPSG publishes a zero shift to WGS 84 for, opens with nothing
but its URL. That zero shift is EPSG's, not exact: measured against PROJ, every
such system lands within 1.35 m, the furthest being NAD83's CSRS and HARN
realizations.

A file on an older datum — Korean 1985, DHDN, Amersfoort, OSGB 1936 — is
refused. Reaching WGS 84 from it takes a shift the file does not state, and
without one every point would land tens to hundreds of metres off with no
error. The error names the system and the call that opens the file anyway:

```
This file uses EPSG:5174, whose datum needs a shift to reach WGS84 that the
file does not state. […]

    COPCTilesetProvider.fromUrl(url, { crs: '<proj4 definition>' });

The definition for EPSG:5174 is at https://epsg.io/5174 […]
```

`crs` takes a proj4 string or a WKT, and replaces the file's own description
entirely. For an older datum it has to state the shift — in proj4, a
`+towgs84=` term. Its accuracy is yours; this library applies what it is given.

A file whose description names no EPSG code is refused the same way, with
`CrsCodeNotFoundError`, and so is a file that stores no description at all,
with `WktNotInVlrsError`; `crs` opens both.

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

Unstyled, points take the file's own colour, whether its writer scaled it to
LAS's 16 bits or left 8-bit values in those fields. LAS point format 6 carries
none, so such a file renders in Cesium's constant dark grey until a style
gives it a colour — every property above is still there to style on.

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
| `crs` | the file's own | The file's horizontal coordinate system, as a proj4 string or WKT, used instead of the one the file declares. See [Coordinate systems](#coordinate-systems). |
| `geoidHeight` | — (HAE) | The geoid's separation from the WGS84 ellipsoid at this file's location, in metres, added to every height. Omit it for a file whose Z is already ellipsoidal. See [Limits](#limits). |

### Provider

| Member | Type | What it is |
|---|---|---|
| `tileset` | `Cesium3DTileset` | The live tileset. Styling, events and traversal settings go here. |
| `extent` | `Rectangle` | The file's extent, for camera framing. |
| `stats()` | `ProviderStats` | Request and loading counters, for diagnostics. |
| `destroy()` | `void` | Releases the tileset and its Workers. Safe to call more than once. |

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
