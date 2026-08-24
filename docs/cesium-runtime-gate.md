# Browser render gate — findings

A throwaway harness answering one question: **does this library put its own
points on a Cesium globe in a real browser?**

The harness itself is not on `main`. It lives in `gate/` on branch
`gate/render` (commit `f3887de`), which is where every `gate/...` path below
resolves; `gate/README.md` there says how to run it. This page is the part
that was worth keeping.

Answer: **yes.** Chromium 1234 headless, SwiftShader, Cesium 1.143.0, Vite
8.2.1 dev server, 2026-08-23. Three cases, all passing.

## What was measured

The fixtures are assembled from the pinned slices already in `fixtures/`
(`gate/build-fixture.mjs`): the Autzen header and VLRs, the real 951-byte LAZ
chunk for node 5-16-3-1 (47 points), and a hand-encoded hierarchy page whose
entries point at that chunk. `one.copc.laz` is 2,719 bytes with a single node;
`nine.copc.laz` is 2,975 bytes with a root and eight children, every one
naming the same chunk. The 81 MB source file is never needed.

| | one tile | nine tiles, pool of 1 | control: no provider |
|---|---|---|---|
| content states | `READY` | `READY` x9 | — |
| points selected | 47 | 423 (47 x 9) | 0 |
| tiles selected | 1 | 9 | 0 |
| lit pixels | 20 | 20 | **0** |
| frames rendered | 19 | 26 | 60 |
| Range requests | 4 | 12 | 0 |

The pixel count only means something against the zero: the control runs the
same scene, the same 60 frames and the same readback with no provider added,
and finds nothing lit. Globe, sky box, atmosphere, sun and moon are all off —
the Decision 2 gate learned that the starfield alone doubles the count.

Nine overlapping tiles light the same 20 pixels as one because all nine carry
the same 47 points at the same coordinates. That is the fixture's doing, not
a rendering result.

## What the gate found that offline tests could not

**1. The Worker cannot import the package root.** `src/index.ts` documents
itself as the import a caller's Worker module uses — `createWorkerHandler` is
exported there precisely because `exports` is a single path. But that same
file re-exports `COPCTilesetProvider`, so importing it pulls Cesium into the
Worker realm, which dies:

```
Uncaught ReferenceError: global is not defined
  @ node_modules/.vite/deps/cesium.js
```

The offline suite cannot see this: `tests/worker-entry-node.ts` imports
`../src/worker/entry.js` directly. The gate had to do the same to proceed,
which is not a path a published caller has. **The publish sub-project has to
give the Worker realm its own entry** — a `./worker` subpath, a separate
bundle, or both — and until it does, the doc comment in `src/index.ts`
describes an import that does not work.

**2. `laz-perf.wasm` has no owner.** laz-perf resolves its `.wasm` relative to
wherever its script was served from. Under Vite that is a path no static root
covers, so the dev server's SPA fallback answers with `index.html` and the
decode dies on `expected magic word 00 61 73 6d, found 3c 21 64 6f` (`<!do`).
The gate serves it from a middleware. A real consumer has no such middleware,
so **the Worker bundle has to carry or locate this file deliberately.**

**3. The package exports `WorkerPort` but ships no adapter.** A browser
`Worker` does not satisfy it — `WorkerPort.onMessage` registers a handler,
`Worker.onmessage` is a slot. Every browser caller writes the same ~10-line
adapter (`browserPort` in `gate/main.ts`). Worth deciding whether the library
should ship it.

## What the gate confirmed that only a render loop could

**Deferred work is re-asked, and all of it eventually lands.** The nine-tile
run with `workerPoolSize: 1` (so a decode capacity of 2, per §7) recorded:

- `decode`: 9 admitted, **13 deferred**, 0 rejected, 0 in use at the end.
- `hostRequests`: 9 admitted, **3 deferred**, peak 6 — the §7 per-host cap of
  6 actually bound.

Thirteen decode deferrals and three Range deferrals, and all nine tiles
reached `READY` with every lease returned. This is `encodeWhenAdmitted`'s
retry loop and Cesium's own `fetchArrayBuffer -> undefined` contract observed
working in a live traversal. Both were previously fixed only by reading
Cesium's source; carried-forward listed the second as a browser question.

**The wire error path works across a real Worker.** Before the wasm was
served, the decode failure came back as a properly reconstructed
`WorkerTaskFailedError` carrying laz-perf's own message — `fromWire` doing its
job across a genuine `postMessage` boundary rather than a test double.

## What the gate did not prove

- **That it renders from the published bundle.** Vite served the TypeScript
  sources and resolved the Worker with `new URL('./worker.ts', import.meta.url)`.
  The Rollup library and Worker bundles (OVERVIEW §5) do not exist yet, so the
  gate proves the pipeline, not the artifact. The `npm pack` smoke test in §5
  remains the only thing that will.
- **Anything about coalescing.** `bytesWasted: 0`, `requestsSaved: 0` in every
  run — the merge path still has no production caller, so §7's two Range
  knobs remain unmeasured.
- **Anything about a real node.** 47 points is the smallest thing that can
  light a pixel. Nothing here says what 61,201 points cost.
- **Hierarchy page expansion.** Both fixtures fit in a single root page, so
  `hierarchy` shows 0 admitted throughout. The Decision 2 gate proved the
  external-tileset expansion path; this one did not exercise it.
