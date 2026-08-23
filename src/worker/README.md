# worker

Two realms in one directory: the pipeline that runs inside a Worker, and the
pool on the main thread that drives it. Decision 3 puts the heavy work — LAZ
decompression, coordinate transform, PNTS encoding — off the main thread;
this module is both halves of that split and the message protocol between
them.

## The realm split

**Worker realm** — everything a Worker's own code runs:

- `decode.ts` — `decodeChunk` decompresses one COPC chunk's compressed bytes
  into a readable point view (`DecodeHeader` describes the header fields it
  needs).
- `positions.ts` — `toRelativePositions` transforms the view to ECEF and
  re-centres it on the tile's own bounding-box midpoint, for float32
  precision.
- `pnts.ts` — `encodePnts` writes the 3D Tiles 1.0 PNTS bytes, batch table
  included.
- `pipeline.ts` — `encodeNode`, the pipeline's single entry point, composing
  the three stages above. Refuses a zero-point view with a typed
  `ZeroPointChunkError` before it reaches the encoder — Decision 6 forbids
  serving an empty PNTS by any path.
- `index.ts` — the pipeline's own barrel: `encodeNode`, `EncodeNodeInput`,
  `DecodeHeader`. `decodeChunk`, `toRelativePositions` and `encodePnts` are
  not re-exported here — each is a stage `encodeNode` composes, not
  something a caller should invoke on its own without its zero-point check.
- `entry.ts` — `createWorkerHandler(post)`, the message handler that turns a
  `ToWorker` message into a pipeline call and a `FromWorker` reply.
  Deliberately free of any platform API, so it needs a bootstrap to become a
  real Worker. `tests/worker-entry-node.ts` is that bootstrap for
  `node:worker_threads`; **no browser bootstrap exists yet** — that belongs
  to the bundling sub-project, alongside the Rollup self-contained Worker
  bundle OVERVIEW §5 calls for.

**Main-thread realm** — `pool.ts`: `createWorkerPool`, `WorkerPool`,
`EncodeVerdict`, `EncodeRequest`, `WorkerPoolOptions`, `DEFAULT_POOL_SIZE`.
Admits work against a `Budget` lease, spawns `WorkerPort`s lazily, dispatches
admitted tasks to whichever port is free and ready, and settles each task's
promise exactly once no matter which terminal path gets there first: success,
a `failed` reply, either cancellation shape (never posted vs. already
posted), a port error, or the pool's own `destroy()`. `EncodeRequest.compressed`
is transferred to a Worker, not cloned, the moment a port actually posts it —
which may be later than the `encode()` call that admitted it, if every port
was busy at the time — so a caller must not resubmit the same `EncodeRequest`
once its first submission has been admitted.

**Shared** — `protocol.ts`: `ToWorker`, `FromWorker`, the message shapes both
realms agree on, and `WorkerPort`, the four-method interface a platform
adapter implements so `pool.ts` never touches `postMessage`/`on` directly.
There is no `cancel` message: a task the pool has not posted yet is cancelled
by forgetting it, and a task already posted is inside a synchronous decode
that a message would arrive too late to stop.

This is the one place in the module a reader coming from `src/crs/` should
slow down: there, the main-thread realm is `index.ts` and the Worker realm is
`worker.ts`. Here the barrel names are swapped — `index.ts` is the Worker
realm's own barrel (the pipeline), and the main-thread realm's file is
`pool.ts`, not `index.ts`.

`entry.ts`, not `index.ts`, is what the boundary is actually checked against,
since it is the file a bootstrap loads into a real Worker.
`tests/worker-boundary.test.ts` walks its import closure and asserts it
reaches `pipeline.ts`, `decode.ts`, and `crs/transform.ts`, but never
`crs/registry.ts`, `crs/resolve.ts`, or `crs/index.ts` — the CRS registry is
main-thread-only module state, and a Worker's own copy would hold none of
what the caller registered — and never `pool.ts`: a Worker that pulled the
main thread's pool in would carry the main thread's half of the system into
every Worker, and nothing else would notice.

## Limits worth knowing

`browser.ts` is the browser bootstrap, and `dist/worker.js` is built from it.
It does two things at once: importing it gives you `createWorkerHandler`, and
evaluating it inside a Worker installs a handler on `self`. That is what lets
one artifact serve both the Blob URL `fromUrl` builds by default and the
`copc-tileset-provider/worker` subpath a caller reaches for when a `worker-src`
CSP blocks `blob:`.

`tests/worker-entry-node.ts` still drives `entry.ts` inside
`node:worker_threads` for tests, and `tests/worker-boundary.test.ts` now walks
`browser.ts`'s import closure as well — the Cesium exclusion there is a check,
not a promise. The render gate measured why it matters: a Worker that reaches
Cesium dies on `ReferenceError: global is not defined` before handling a single
message (`docs/gate-render-findings.md`).

Two things that gate found and reading could not. `laz-perf` resolves its
`.wasm` against wherever its script was served from, which is why
`lazperf.ts` hands it the bytes directly and no `.wasm` file ships. And the
Worker must not reach `src/index.ts` — the package root re-exports
`COPCTilesetProvider` and so pulls `cesium` in.

The batch table's property names and types — `Classification`, `Intensity`,
`GpsTime`, `ReturnNumber`, `NumberOfReturns` — become a contract once a
version ships with them: a caller's Cesium style strings and picking code
get written against this exact set, so narrowing or removing one afterward
breaks their code, not this library's. `PointSourceId` is deliberately
excluded, on the shape of the bet rather than a guess at demand: adding a
property later keeps every existing style string working, while removing or
narrowing one does not — so omission is the reversible half. And `BATCH_ID`
and the GPS time convention cannot be revisited separately: Cesium's
`PntsLoader` builds a property *table* only when batch IDs are present,
where a batch table's `DOUBLE` transcodes to `FLOAT64` and precision
survives; without them it falls back to property *attributes*, where every
value is cast to `Float32Array`. Which GPS time convention a file actually
uses (LAS's `globalEncoding` bit chooses between GPS Week Time and Adjusted
Standard GPS Time) is the file's decision, not this module's, so `GpsTime`
has to stay a `DOUBLE` — and `BATCH_ID` present — for whichever convention a
given file turns out to carry.

`pool.ts` holds no queue of its own beyond ports waiting for a task: the
`Budget` lease *is* the queue (OVERVIEW §3 Decision 5's admitted/deferred/
rejected admission). A `deferred` verdict is never retried inside the pool —
it is returned to the caller, and the caller's own next call is the retry.

OVERVIEW §3, Decision 3, Decision 5 and Decision 6.
