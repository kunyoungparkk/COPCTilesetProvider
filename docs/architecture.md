# Architecture

For someone about to change this library. It explains how the pieces fit; it
does not explain how to use the library ([README](../README.md)) or how to run
the suite ([CONTRIBUTING](../CONTRIBUTING.md)).

The binding argument for every decision below is [OVERVIEW.md](../OVERVIEW.md),
which is written in Korean. This document is the English map of what that
argument produced. Where the two disagree, OVERVIEW is right and this file is a
bug.

## The one idea

A COPC file is a LAZ file whose points are already sorted into an octree, and
whose header says where each node's compressed chunk begins and how long it is.
That is the whole reason streaming is possible: given the header, the bytes for
any one node can be named exactly, and an HTTP Range request fetches them from
a static host.

Everything here follows from refusing to rebuild what already exists around
that idea. Cesium already has traversal, level of detail, request priority, a
GPU cache, a style language and picking. So the library does not render
anything. It makes a COPC file *look like* a 3D Tiles dataset, and lets Cesium
do the rest.

## The flow

```
fromUrl(url)  ─ reads the header and root hierarchy page over Range
              → converts the COPC octree into a synthetic 3D Tiles document
              → creates a Cesium3DTileset and installs a content codec

per frame     ─ Cesium's traversal picks the tiles it wants
              → each tile's URI is intercepted, budgeted, and fetched as a Range
              → a Worker decompresses the LAZ chunk, projects it to ECEF,
                and encodes PNTS
              → Cesium owns display, caching, unloading, styling and picking
```

Two things in that sketch are worth pausing on, because they are where most of
the design pressure lands.

**The tile URIs are opaque tokens, not URLs.** The synthetic document gives
every content-bearing tile a URI that resolves to nothing. `ScheduledRangeResource`
intercepts the request Cesium makes for it, looks the token up in a registry to
recover the node's byte range, and answers from the network itself. This is how
a document that describes an octree stored inside one file can be traversed by
an engine that expects one file per tile.

**Cesium is handed decoded content, not bytes it understands.** Bytes arrive as
LAZ, which Cesium cannot parse. A private slot on `Cesium3DTileset` —
`_runtimeContentCodec` — lets the library take over content creation for those
bytes and return a finished `Cesium3DTileContent`. That slot is not public API,
which is why the peer range is narrow and why one whole test file reads
Cesium's own source to check the slot still behaves as assumed.

## What each directory owns

Each has its own README with the detail; this is the index.

| Directory | Owns |
|---|---|
| [`src/copc`](../src/copc) | Reading the file's own structure — header, info VLR, hierarchy pages — into the node descriptors every other module works from. |
| [`src/range`](../src/range) | Verified HTTP Range transport. Every read proves itself with an exact `206` and `Content-Range`; adjacent chunks are coalesced into one request. |
| [`src/crs`](../src/crs) | The coordinate pipeline: WKT → EPSG code → registered proj4 definition → WGS84 → ECEF. |
| [`src/tileset`](../src/tileset) | Mapping the octree onto a synthetic 3D Tiles document, and the registry that turns a tile's opaque URI back into a byte range. |
| [`src/worker`](../src/worker) | Two realms in one directory: the pipeline that runs inside a Worker, and the pool on the main thread that feeds it. |
| [`src/budget`](../src/budget) | Admission control over Range body bytes, host request slots and decode jobs — admitted, deferred or rejected — with every reservation released exactly once. |
| [`src/cesium-runtime`](../src/cesium-runtime) | The only place that touches CesiumJS: the provider, the request interception, the codec. |
| [`src/errors`](../src/errors) | The typed errors, which are public API: each names what failed and the exact change that fixes it. |

## The three boundaries

More of this design is about what code *cannot* reach than about what it does.
Each of these is enforced by a test that walks the real import graph, so moving
an import can fail the suite without changing any behaviour — that is
deliberate, and the failure message says which boundary was crossed.

1. **Only `src/cesium-runtime/` may name Cesium as an import.** Every other
   file under `src/` is engine-agnostic. `tests/cesium-boundary.test.ts` scans
   every `.ts` file outside that directory for a `cesium` or `@cesium/engine`
   specifier, and separately confirms `src/index.ts` still reaches the provider
   and the Worker pool — so the rule cannot be satisfied by the library simply
   falling apart.
2. **A Worker may not reach the CRS registry.** The registry is module state,
   and a Worker gets its own empty copy — so consulting it there would reject
   every real file. What crosses the realm boundary is the *answer*: a proj4
   definition string, resolved once on the main thread. Enforced by
   `tests/crs-worker-boundary.test.ts`.
3. **A Worker may not reach Cesium.** The Worker entry point imports nothing
   that leads to it; measured, a Worker that does dies before it handles its
   first message. Enforced by `tests/worker-boundary.test.ts`, and by an
   assertion in `build/assert-bundles.mjs` against the built bundle.

All three depend on one scanner (`tests/import-closure.ts`) being right about
which specifiers a file imports, which is why that scanner has a test file of
its own. A scanner that silently missed an import would make all three
guarantees vacuous.

## Decisions worth knowing before you change something

Summarised from [OVERVIEW §3](../OVERVIEW.md), which carries the reasoning and
the measurements. These are binding: work that contradicts one needs the
decision changed first, not worked around.

1. **Do not build a renderer.** No octree traversal, no request queue, no GPU
   cache of our own. Cesium's are better and already exist.
2. **`_runtimeContentCodec` is the main path.** A private Cesium slot, used by
   Cesium's own first-party MVT provider the same way. Everything that touches
   it lives in `src/cesium-runtime/`, the supported Cesium range is narrow, and
   an offline test reads Cesium's source to catch the day the contract moves.
3. **Heavy work happens in a Worker.** LAZ decompression, coordinate transform
   and PNTS encoding. Only the compressed input and the encoded output cross,
   as transferables.
4. **Verified Range only, and no whole-file fallback.** A fallback would
   quietly turn streaming into a download, which is the thing the library
   exists to avoid. Round trips are reduced by coalescing adjacent chunks, not
   by guessing ahead — there is no speculative prefetch.
5. **Budgets and leases, released exactly once.** Range body bytes, host
   request slots and decode jobs each have a ceiling; every reservation returns
   on success, failure, cancellation and destroy alike. (OVERVIEW's Decision 5
   also names a hierarchy budget; `src/budget` does not carry a counter for one
   today.)
6. **Synthetic tileset and encoding conventions.** `ADD` refinement, geometric
   error halving with depth, RTC-relative float32 positions, PNTS with a batch
   table, WGS84 region bounding volumes, and a CRS registry seeded with
   EPSG:4326 alone.

## What is measured, and where it is written down

This project distinguishes between what it knows and what it assumes, and the
distinction is kept in files rather than in memory.

- [`src/cesium-runtime/gate-findings.md`](../src/cesium-runtime/gate-findings.md)
  — what a real browser render measured, including the things offline tests
  could not have caught. Source comments cite it as evidence.
- [`fixtures/README.md`](../fixtures/README.md) — the pinned byte slices the
  suite runs against, cut from a real public file, with their provenance
  recorded so they cannot drift into fiction.
- [`OVERVIEW §7`](../OVERVIEW.md) — the tuning knobs, each with its initial
  value and where that value came from. Changing one is expected to come with
  a measurement, and to update the table.
