# Carried forward

Obligations a finished sub-project handed to a later one. Each names the plan
that must carry it, so it is picked up when that plan is written rather than
rediscovered. Delete an entry when the work lands.

## For the tileset / Worker sub-project

- **Check when Cesium fetches an external tileset whose placeholder shares its
  geometric error.** The synthetic tileset gives a page-pointer tile and the
  root of the tileset it expands into the same key, and therefore the same
  geometric error. Whether traversal then fetches the expansion at the right
  moment is a browser question; the hard gate proved the expansion path works,
  not its timing.

- **Measure what `BATCH_LENGTH == POINTS_LENGTH` costs before v1.** Every PNTS
  tile declares one batch per point, so Cesium builds a per-feature table sized
  to every point in the tile — for a real 50k-point node, 50k features per tile.
  Nobody has measured what that costs in memory or in picking-texture terms.
  `BATCH_ID` is required for picking (Decision 6), so this is a sizing question,
  not a question of whether to keep it.

- **The `>>> 8` colour rule needs an owner.** `src/worker/pnts.ts`'s doc
  comment is right about what the Autzen measurement settles (every
  Red/Green/Blue value is an exact multiple of 256 and none a multiple of
  257 — 8-bit colour left-shifted into a 16-bit field) and right to refuse
  a per-tile heuristic (neighbouring tiles guessing differently would
  produce a visible seam between them). But the whole-file or
  header-driven decision it explicitly defers to has no owner anywhere in
  `src/` yet. The symptom this leaves open: a writer that stores genuine
  8-bit colour unscaled in the low byte of these 16-bit fields (rather than
  left-shifted into the high byte) produces a uniformly black tileset,
  silently, under the current unconditional `>>> 8` — and it would be
  reported as "the library is broken," not as a colour-convention
  mismatch. Belongs at `fromUrl` time (one whole-file inspection), the
  same layer OVERVIEW already reserves for CRS resolution.

- **Decide `Withheld` before the batch table has users.** LAS 1.4 marks a
  point the producer deleted with a `Withheld` flag bit, and viewers
  conventionally hide those points. `node_modules/copc/lib/las/extractor.js`'s
  `create6` exposes it alongside `Synthetic`, `KeyPoint`, `Overlap` and
  `ScannerChannel`, but the batch table this branch froze carries none of
  them — so a caller has no way to write the style that hides withheld
  points, and they render. The deliberate exclusion discussion in
  `src/worker/pnts.ts` covers only `PointSourceId`; this one was never
  considered. Adding it is backward-compatible, so this is a decision to make
  on purpose rather than a defect — but making it after release means a
  second contract revision.

- **`EncodeVerdict`'s `admitted` no longer means "this will be attempted".**
  On the `spawn`/`post` failure paths a caller gets `{ verdict: 'admitted' }`
  with an already-rejected promise. That is correct — `admitted` is the
  budget's verdict, not a promise about the Worker — but it is a distinction
  the first codec author will have to be told rather than discover.

- **Budget stats count admissions that never reached a port.** Measured during
  the pool's own review: twelve tasks against a throwing `spawn` recorded
  `admitted: 12` while none ever ran. Correct as admission accounting, and
  §7's decode row is tuned from these numbers — worth knowing before anyone
  tunes `decodeJobs` off them.

## For the range sub-project

- **Link `readMany`'s coalesced group requests under one `AbortController`.**
  They currently run under an unlinked `Promise.all` (`src/range/range-reader.ts`,
  the `readMany` function, `await Promise.all(...)` around line 330): when one
  group fails fatally, the caller's promise rejects but its siblings keep
  going. The budget design doc (`docs/superpowers/specs/2026-08-21-budget-design.md`,
  "Prerequisite" section) measured a sibling answered 503 running its full §7
  retry ladder — two further requests over 2.5 s — after the caller had
  already been given the error, incrementing the reader's cumulative counters
  while doing it. The fix is a linked `AbortController` inside `readMany`: a
  fatal group failure aborts its siblings, the caller still sees the original
  error, and the siblings end silently. It has to land before a budget lease
  can be held around a `readMany` call (`src/budget/`), because work that
  outlives the call has no moment at which its lease could be returned — that
  dependency is the budget module's whole reason for naming this, not
  something the budget module fixes itself. The only prior trace of this
  defect anywhere in the repo was a parenthetical in a test comment
  (`tests/range-reader.test.ts`, around the "Promise.all rejects as soon as
  one group does" comment near line 618); this entry is the record the design
  doc's own "Prerequisite" section observed did not exist.

- **Coalescing has no production caller, so §7's two Range knobs cannot be
  measured.** The whole merge implementation — gap threshold, waste ratio,
  buffer splitting — lives behind `readMany`, and `readMany` is called only
  from inside `src/range/` and from tests. Every production read goes through
  `read()`, one Range request for one tile, because that is the shape Cesium
  hands us: `Resource.fetchArrayBuffer` is asked for one tile's bytes at a
  time. So `RangeStats.requestsSaved` and `bytesWasted` are structurally
  always `0` — measured on a live provider that fetched the root hierarchy
  page and then one node's chunk: `{"requests":4,"retries":0,
  "bytesRequested":11797,"bytesWasted":0,"requestsSaved":0}` — and §7 says the
  256KB gap threshold and the 2% waste cap may move only on measurements from
  exactly those two numbers.
  What is needed is a batching layer above `fetchArrayBuffer`: hold the tiles
  Cesium asks for within one frame, decide which are adjacent enough to merge,
  issue one `readMany`, and settle each tile's own promise from its own slice.
  That is design work rather than wiring — Cesium's contract is per-tile and
  synchronous in its verdict (`undefined` means "ask again next frame"), so
  the batching layer has to decide how long to hold a tile before answering it
  and what to do when the frame ends. It is blocked on the `AbortController`
  entry above: a budget lease held around a `readMany` call has no moment at
  which it could be returned while a sibling group outlives the call.

## For whichever sub-project first ships a root README

- **State the ellipsoidal-height (HAE) limitation.** OVERVIEW §6 requires it and
  no root `README.md` exists yet. `src/crs/ecef.ts` and `src/crs/README.md`
  carry the fact; the user-facing page does not.

- **State that PNTS is 3D Tiles 1.0 legacy, with the adoption rationale, and
  place the glTF transition after v1.** OVERVIEW §3 Decision 6 requires all
  three, and none of them is in a user-facing page yet because none exists.
  The rationale itself: a hand-rolled Worker encoder (header + feature table
  + binary) is simpler than assembling glTF, and a batch table gives
  Cesium's style language and picking (`BATCH_ID` per point, required for
  picking — `src/worker/pnts.ts`'s own doc comment) for free. Decision 6
  puts the glTF transition explicitly after v1, not as a v1 concern.

- **State that the default Worker comes from a `blob:` URL.** `fromUrl` builds
  it from the bundle inlined into the library, so a strict `worker-src` policy
  that forbids `blob:` blocks it outright. The library cannot fix that; the way
  out is `spawnWorker` with `browserPort`, or importing
  `copc-tileset-provider/worker` in a Worker module of the caller's own. Both
  ship for this reason and neither is discoverable without being written down.

- **State that a bundler ignoring `browser` fields will break.** `copc` is an
  external dependency, so a consumer's bundler resolves `laz-perf` itself, and
  what keeps it off the Node build — with its `require("fs")` — is laz-perf's
  own `"browser": "lib/web/index.js"`. A toolchain that ignores that field
  fails. The publish smoke builds with Vite, which honours it, so this path is
  unmeasured (`smoke/README.md`).

## For whichever sub-project next touches `src/cesium-runtime/`

- **A decode job cannot be cancelled, and the reason is Cesium's, not ours.**
  Range reads and `fromUrl` are cancellable now (`cancellation.ts`,
  `COPCTilesetProviderOptions.signal`), so a tile the camera moved past
  releases its byte budget and host slot at once. Decode jobs still run to
  completion, and wiring a signal in would be a regression rather than the
  finish of the job: `Cesium3DTile.js`'s catch around `makeContent` does not
  consult `request.cancelled` the way its catch around the request promise
  does, so an aborted decode sends the tile to `FAILED` — terminal here —
  instead of back to its previous state. Saving one worker slot at the cost
  of a permanently dead tile is worse than the waste.
  `tests/cesium-contract.test.ts` pins both catches, and the day the second
  one starts checking `cancelled` is the day this becomes available; that
  test failing is the notification.

## Unscheduled

- **The PDAL ground-truth comparison Decision 6 specifies has not been run.**
  PDAL cannot be installed on this machine, so the CRS sub-project verified what
  it could without an outside authority and recorded the gap. Nothing anywhere
  claims otherwise; keep it that way until it is actually run.
