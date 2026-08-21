# Carried forward

Obligations a finished sub-project handed to a later one. Each names the plan
that must carry it, so it is picked up when that plan is written rather than
rediscovered. Delete an entry when the work lands.

## For the tileset / Worker sub-project

- **Reject `+nadgrids` and `proj4.defs`-alias definitions in
  `createTransformFromDefinition`, with a typed error.** Both depend on
  realm-global proj4 state that a definition string only refers to, so proj4
  2.21 returns `[NaN, NaN]` with nothing but a console line, or throws a value
  that is not an `Error`. `src/crs/README.md` records the limitation; this is
  the check that makes it loud.

  The seam is the builder, not the Worker init message: the main thread builds
  a transform of its own at `fromUrl` time. Measured on this branch, with
  `+nadgrids=@missing.gsb` appended to the definition the tests register,
  `regionForKey` on the root key returns
  `[NaN, NaN, NaN, NaN, 123.79147200000011, 1542.790920000003]` and
  `measureRootGeometricError` returns `NaN` — the heights survive because they
  never touch proj4. A whole tileset of half-NaN bounding volumes therefore
  reaches Cesium without a throw, before the Worker this check was scheduled
  for exists. `createTransformFromDefinition` is the one chokepoint both
  consumers pass through, and a typed error thrown there still reaches the
  caller's `fromUrl` promise.
- **Call `resolveCrsDefinition` once, on the main thread, at open time**, and
  put its answer in the Worker's init message. It throws `CrsNotRegisteredError`
  and `CrsCodeNotFoundError`, which have to surface where `fromUrl` can reject;
  the same throw inside a Worker becomes an opaque `messageerror`.

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

- **Refuse `pointCount > 0` with `byteSize == 0`, and decide where.** Measured
  on the shipped code: such an entry is admitted by `checkedLength` (which
  refuses only a negative length, and must admit zero because a zero-point node
  legitimately has `offset 0, byteSize 0`), becomes a `points` entry with a byte
  range nobody can request, and dies one layer down as
  `InvalidByteRangeError: length 0 at offset 4096` — the wrong-blame failure
  `checkedLength` exists to prevent, one value over from the one that was fixed.
  The invariant that actually holds is `pointCount > 0` ⟺ `length > 0`, and
  neither side of the seam checks it. A milder sibling: a page pointer with
  `pageLength 0` reaches `readHierarchyPage`'s zero-length early return and
  expands into an empty external tileset rather than being refused.

- **Read `entry.kind`, not the URI's `n/` vs `h/` prefix.** They are redundant
  encodings of the same fact (`src/tileset/build.ts`), so treat the prefix as
  cosmetic or the two will eventually disagree.

- **When the `+nadgrids` guard lands, move the measurement with it.** The seam
  is now named in four places, but the numbers behind it live only in this file.
  Deleting this entry without carrying the measurement into the implementing
  code loses the evidence for why the check exists.

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

## For whichever sub-project first ships a root README

- **State the ellipsoidal-height (HAE) limitation.** OVERVIEW §6 requires it and
  no root `README.md` exists yet. `src/crs/ecef.ts` and `src/crs/README.md`
  carry the fact; the user-facing page does not.

## Unscheduled

- **The PDAL ground-truth comparison Decision 6 specifies has not been run.**
  PDAL cannot be installed on this machine, so the CRS sub-project verified what
  it could without an outside authority and recorded the gap. Nothing anywhere
  claims otherwise; keep it that way until it is actually run.
