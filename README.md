<!-- Screenshot goes here, directly under the title: a single wide PNG of a real
     point cloud on the globe. Demo link goes on the line below it. -->

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

const provider = await COPCTilesetProvider.fromUrl('https://example.com/autzen.copc.laz');
viewer.scene.primitives.add(provider);
viewer.camera.flyTo({ destination: provider.extent });
```

## Install

```sh
npm install copc-tileset-provider cesium
```

Published as [`copc-tileset-provider`](https://www.npmjs.com/package/copc-tileset-provider).
The version is `0.x` on purpose: the library builds, bundles and renders — a
publish smoke test packs a tarball, installs it into a throwaway project and
renders it in headless Chromium on every run — but the API has not been lived
with by anyone outside this repository yet, so it may still move.

Cesium is a peer dependency, pinned to the versions this library was verified
against. Both ends of that range are rendered in a real browser before it is
widened — 1.142.0 and 1.144.0 at the time of writing:

```json
"peerDependencies": { "cesium": ">=1.142.0 <1.145.0" }
```

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
  'https://example.com/autzen.copc.laz',
);

viewer.scene.primitives.add(provider);
viewer.camera.flyTo({ destination: provider.extent });
```

`provider` is a Cesium primitive: `scene.primitives.add` takes it directly, and
`provider.destroy()` releases the tileset, the Worker pool and every outstanding
reservation.

<!-- Once examples/ exists, add here:
       A complete, runnable example is in [`examples/`](examples/). -->

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

If the file names a system you have not registered, the error tells you which
one and hands you the call to make:

```
This file uses EPSG:2992, which is not registered. Only EPSG:4326 is known by
default, so every other system has to be supplied once, before the file is
opened:

    registerCrs(2992, '<proj4 definition>');

The definition for EPSG:2992 is at https://epsg.io/2992 — take its proj4
string. Its accuracy is yours to vouch for; this library only applies what it
is given.
```

Accuracy of a registered definition is the registrant's responsibility. This
library applies what it is given.

## Your server has to support Range requests

Every read is an HTTP Range request, and every response is verified: a `206`
whose `Content-Range` matches what was asked for. **There is no fall back to
downloading the whole file** — a fallback would quietly turn streaming into a
full-file download, which is the thing this library exists to avoid.

Two consequences worth checking before you file a bug:

- **The host must serve `206`.** Most static hosts do. Some CDNs and proxies
  strip Range support on compressed responses.
- **Cross-origin needs one extra header.** Browsers hide `Content-Range` from
  JavaScript unless the server sends
  `Access-Control-Expose-Headers: Content-Range`. Without it the response cannot
  be verified at all, so the request fails immediately with a typed error naming
  the header rather than retrying.

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

**Heights are ellipsoidal.** Every Z is treated as height above the WGS84
ellipsoid (HAE). Data stored as orthometric height — above a geoid — will sit at
a visible vertical offset. Geoid correction is out of scope for v1, as it is for
comparable implementations.

**Content is PNTS, which is 3D Tiles 1.0 legacy.** The format is superseded by
glTF-based content in 3D Tiles 1.1. It was chosen deliberately: a Worker can
hand-encode PNTS (a header, a feature table, a binary body) far more simply than
it can assemble glTF, and a PNTS batch table gives Cesium's style language and
picking for free — picking requires a `BATCH_ID` per point, which the batch
table supplies. Moving to glTF is on the roadmap **after** v1, not as a v1
concern.

**The default Worker comes from a `blob:` URL.** `fromUrl` builds one from a
self-contained bundle inlined into the library, so nothing has to be served or
configured. A strict Content Security Policy that forbids `worker-src blob:`
blocks it, and the library cannot work around that. Two ways out, both shipped
for this reason:

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

**A bundler that ignores `browser` fields will fail to build.** `copc` is a
normal dependency, so your bundler resolves `laz-perf` itself. What keeps it off
laz-perf's Node build — which reaches for `require("fs")` — is laz-perf's own
`"browser": "lib/web/index.js"`. Vite and webpack honour that field by default,
and esbuild does when its platform is `browser`. Plain Rollup does not until
`@rollup/plugin-node-resolve` is given `{ browser: true }`. A toolchain that
resolves the Node build instead needs an alias to `laz-perf/lib/web/index.js`.

Only the Vite path is actually measured — the publish smoke builds with it.

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

## How it works

```
fromUrl(url)  ─ reads header + root hierarchy over Range
              → converts the COPC octree into a synthetic 3D Tiles document
              → creates a Cesium3DTileset and installs a content codec

per frame     ─ Cesium's traversal picks the tiles it wants
              → each tile's URI is intercepted, budgeted, and fetched as a Range
              → a Worker decompresses the LAZ chunk, projects it to ECEF,
                and encodes PNTS
              → Cesium owns display, caching, unloading, styling and picking
```

The engine is not reimplemented. Traversal, level of detail, request priority
and the GPU cache are Cesium's, and the library's job is to make a COPC file
look like something Cesium already knows how to draw.

## Development

```sh
npm test          # Vitest, offline, no build required
npm run typecheck # tsc --noEmit
npm run build     # rolldown + tsc → dist/
npm run smoke     # pack, install into a temp project, render in headless Chromium
```

`npm run smoke` installs from the network and is a pre-publish check, not part
of CI — CI stays offline.

Design decisions and their reasoning live in [`OVERVIEW.md`](OVERVIEW.md)
(Korean), and the specs and plans behind each subsystem are in
[`docs/`](docs/). Repository conventions are in [`CLAUDE.md`](CLAUDE.md).

## License

MIT. See [LICENSE](LICENSE).
