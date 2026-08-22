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

- **Check that a `deferred` admission actually gets re-asked.** The budget
  answers synchronously and holds nothing, on the reading that Cesium's
  traversal re-requests the tile next frame (§4). If an intercepted `Resource`
  that declines instead marks the tile failed, the tile never returns, and the
  budget cannot tell — it has already forgotten the request by design.

- **Decide who validates `TilesetContext.tokenBase`.** Its contract — absolute
  with a scheme (Decision 2's first constraint), trailing `/`, characters that
  survive URI normalisation, stable and unique per provider — is documented on
  the type and enforced by nothing. Every test passes `copc://a1b2c3/`. A
  relative prefix would silently produce relative content URIs, which is the
  failure that constraint exists to name. The provider is the only caller, so
  the check belongs there or nowhere.

- **Read `entry.kind`, not the URI's `n/` vs `h/` prefix.** They are redundant
  encodings of the same fact (`src/tileset/build.ts`), so treat the prefix as
  cosmetic or the two will eventually disagree.

- **Refuse a point format that carries no colour, at open time.** COPC allows
  point data record formats 6, 7 and 8; only 7 and 8 carry RGB. Nothing in
  `src/` validates the format, so a PDRF-6 file reaches `src/worker/pnts.ts`'s
  `view.getter('Red')` and dies with copc.js's untyped
  `Error: No extractor for dimension: Red` — no file named, no format named, no
  guidance, against Decision 6's rule that errors are part of the API. The
  encoder is the wrong layer to fix it in: the check belongs where the header is
  first read, so `fromUrl` rejects before a globe loads rather than after the
  first tile decodes. (Measured during the PNTS sub-project; the untyped throw
  was reproduced, not inferred.)

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

- **Decide what a caller does with a `deferred` it can never satisfy.**
  `WorkerPool.encode` returns the budget's own three-way verdict, and
  `deferred` means "ask again next frame" — which is right when the budget is
  merely full. It carries nothing that distinguishes that from a `spawn`
  factory that is permanently broken (a CSP `worker-src` denial, a bundle that
  will not load). The pool now fails the waiting tasks in that case rather than
  stalling, so nothing hangs, but a codec reading `verdict === 'deferred'` has
  no signal to stop retrying. Adding a third `RejectionReason` was considered
  and rejected here: there is no caller yet to design against, and the type
  would ripple through code nobody has written. Decide it when
  `src/cesium-runtime/` exists and its retry loop is real.

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

## For the publish sub-project

- **`package.json` needs a `files` field before the first publish.**
  `src/worker/pipeline.ts` cites `docs/superpowers/plans/carried-forward.md`
  by path in a doc comment, and the file is tracked in the repo so that
  pointer resolves today. But `package.json` has no `files` field (checked
  directly), so `npm pack`/`npm publish` falls back to shipping everything
  not excluded by `.npmignore`/`.gitignore` — which would ship
  `docs/superpowers/` (this file included) to consumers. OVERVIEW §5's
  publish smoke test (`npm pack` into an empty project) is the moment this
  would first be caught if it is not fixed before then.

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

## Unscheduled

- **The PDAL ground-truth comparison Decision 6 specifies has not been run.**
  PDAL cannot be installed on this machine, so the CRS sub-project verified what
  it could without an outside authority and recorded the gap. Nothing anywhere
  claims otherwise; keep it that way until it is actually run.
