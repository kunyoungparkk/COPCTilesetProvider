# Cesium runtime and the provider — design

**Goal.** `COPCTilesetProvider.fromUrl(url)` — the one line OVERVIEW §1 promises.
The only module that touches CesiumJS, and the one that composes everything
already built into a primitive a caller adds to a scene.

**Spec.** `OVERVIEW.md` — §1 (the public entry point), §3 Decision 1 (borrow
Cesium's renderer, build no traversal), Decision 2 (`_runtimeContentCodec`, its
three constraints, the isolation rule), Decision 4 (Range only, no request
built on a guess), Decision 5 (budgets, leases, admitted/deferred/rejected),
Decision 6 (errors are API, the empty-node invariant, camera framing from the
header's measured extent), §4 (the runtime data flow), §5 (peer range, no new
dependency), §7 (`maximumScreenSpaceError` is a public option).

## Scope

**In:** the `Resource` subclass that intercepts virtual tile URIs, the codec
that turns tile bytes into Cesium content, the provider that assembles and owns
everything, and the library's public entry point — which does not exist yet
(`src/index.ts` is absent and `package.json` declares no `exports`, `main` or
`types`).

**Out, deliberately:**

- **The browser gate.** `Cesium3DTileset` needs a WebGL context, so nothing
  here can be proved to render in Node. Decision 2's contract was already
  proved in a real browser (commit `c867e5d`, headless Chromium, Cesium
  1.143.0: a point tile reached `READY` with 12 points selected and 3344 lit
  pixels, and a hierarchy tile expanded into a subtree whose own point tile
  loaded, against a server answering both requests with a marker
  `preprocess3DTileContent` rejects). That harness is throwaway and lives on a
  gate branch. What a gate for *this* sub-project would add is proof that our
  real code composes — a different question, and its own piece of work.
  Playwright 1.62.1 is installed but extraneous, left from that gate.
- **Bundling.** The Rollup self-contained Worker bundle OVERVIEW §5 calls for
  does not exist, so the provider takes a Worker port factory rather than
  constructing one. Same seam `src/worker/pool.ts` already draws.

## What was measured before designing

Every claim below was read out of the installed Cesium 1.143.0, not inferred.
Re-run them before implementing rather than trusting this section.

### The codec contract

`Scene/Cesium3DTile.js:1372-1383`:

```js
async function makeContent(tile, arrayBuffer) {
  const codec = tile._tileset?._runtimeContentCodec;
  if (defined(codec) && typeof codec.createContent === "function") {
    const content = await Promise.resolve(
      codec.createContent(tileset, tile, tile._contentResource, arrayBuffer),
    );
    if (tile.isDestroyed()) return;
    return content;
  }
  const preprocessed = preprocess3DTileContent(arrayBuffer);
  ...
```

The early return is Decision 2's second constraint in the source: everything
`preprocess3DTileContent` would have classified — `hasTilesetContent`,
`hasRenderableContent` — is skipped, so the codec sets it. The codec object's
shape is documented at `Scene/Cesium3DTileset.js:772-786`:
`{ contentType, disableSkipLevelOfDetail?, createContent, missingTilePolicy? }`.

The two content factories the codec returns:

- `Model3DTileContent.fromPnts(tileset, tile, resource, arrayBuffer, byteOffset)`
  — `Scene/Model/Model3DTileContent.js:411`, static async.
- `Tileset3DTileContent.fromJson(tileset, tile, resource, json)` —
  `Scene/Tileset3DTileContent.js:108`, static.

`skipLevelOfDetail` is a constructor option (`Cesium3DTileset.js:760`), which is
Decision 2's third constraint: the codec's own `disableSkipLevelOfDetail` field
is documented but never read in 1.143.

### `deferred` is Cesium's own contract, not our invention

This is the finding that removes an open worry from
`docs/superpowers/plans/carried-forward.md` ("check that a `deferred` admission
actually gets re-asked"). `Scene/Cesium3DTile.js:1300-1330`, whose own JSDoc
says *"or undefined if the request cannot be scheduled this frame"*:

```js
const promise = resource.fetchArrayBuffer();
if (!defined(promise)) {
  ++tileset.statistics.numberOfAttemptedRequests;
  return;
}
```

and its caller, `Cesium3DTileset.js:2639-2642`, returns on the same
`undefined`. A tile whose fetch returns `undefined` is **not** marked failed —
it stays unrequested and traversal selects it again next frame. So Decision 5's
three-way verdict maps onto a contract Cesium already had:

| budget | `fetchArrayBuffer` returns | what Cesium does |
|---|---|---|
| `admitted` | `Promise<ArrayBuffer>` | loads the tile |
| `deferred` | `undefined` | counts an attempt, re-asks next frame |
| `rejected` | a rejected promise | the tile fails, which is what a permanent refusal means |

### `clone` is a trap, and Cesium's own subclass shows the way out

`Core/Resource.js:737-751`: `clone(result)` returns a **plain `new Resource`**
when `result` is undefined. `getDerivedResource` goes through it
(`:664-665`), and so does the content request path
(`Cesium3DTile.js:1303`, `tile._contentResource.clone()`).

So a `Resource` subclass that does not override `clone` is silently downgraded
before its first use, and `copc://…` reaches the network. `Core/IonResource.js:175-187`
is the first-party pattern: construct itself when `result` is missing, then
delegate to `Resource.prototype.clone.call(this, result)`. This is the same kind
of precedent Decision 2 leans on for the codec itself.

### A tile resource's class is the *base* resource's class

This decides what `fromUrl` is handed, and it is not obvious. Every tile's
resource is derived from the tileset's:

```js
// Cesium3DTile.js:264
contentResource = baseResource.getDerivedResource({ url: contentHeaderUri });
```

and `Resource.createIfNeeded` (`Core/Resource.js:178-187`), which is what
`Cesium3DTileset.fromUrl` calls on whatever it is given (`:2234`), also goes
through `getDerivedResource` when handed a `Resource`. Both route through
`clone`.

So if the tileset is created from the **Blob URL as a string**, the base is a
plain `Resource`, every `_contentResource` is a plain `Resource`, and our
interception never happens at all — `copc://…` goes to the network and the
whole design fails silently. The tileset must be created from a
`ScheduledRangeResource` whose own `url` is the Blob URL.

Which means our `fetchArrayBuffer` sees two kinds of request: the tileset JSON
at the Blob URL, and tile content at `tokenBase`-prefixed URIs. Anything that
is not a registry hit is delegated to `super.fetchArrayBuffer()`, so the JSON
loads the ordinary way. That delegation is not a convenience — it is what makes
handing our subclass to `fromUrl` viable at all.

### The primitive contract is five methods

`Scene/PrimitiveCollection.js` calls exactly `update`, `updateForPass`,
`prePassesUpdate`, `postPassesUpdate` and `destroy` on its members, and
`Scene.js` calls the first three with `frameState`. Small enough to delegate,
and enumerable enough to guard.

## The shape

| file | responsibility |
|---|---|
| `src/cesium-runtime/resource.ts` | `ScheduledRangeResource extends Resource`: `fetchArrayBuffer` and `clone`. |
| `src/cesium-runtime/codec.ts` | `createContent` for both tile kinds, and the flags the early return leaves to us. |
| `src/cesium-runtime/provider.ts` | `COPCTilesetProvider`: `fromUrl`, the primitive surface, `destroy`, `stats`. |
| `src/cesium-runtime/index.ts` | the module barrel. |
| `src/index.ts` | the library's entry point, plus `exports`/`types` in `package.json`. |

Decision 2's isolation rule is unchanged: nothing outside `src/cesium-runtime/`
imports Cesium or touches an underscore field.

## The public API

```ts
class COPCTilesetProvider {
  static registerCrs(code: number, definition: string): void;
  // `options` is required, not optional: `spawnWorker` has no default until
  // the bundling sub-project ships a self-contained Worker bundle (OVERVIEW §5).
  static fromUrl(url: string, options: COPCTilesetProviderOptions): Promise<COPCTilesetProvider>;

  readonly tileset: Cesium3DTileset;   // styling and picking stay Cesium's — Decision 1
  readonly extent: Rectangle;          // the header's measured extent, for framing
  stats(): ProviderStats;              // see below

  // The primitive surface, delegated:
  update(frameState: unknown): void;
  updateForPass(frameState: unknown, passState: unknown): void;
  prePassesUpdate(frameState: unknown): void;
  postPassesUpdate(frameState: unknown): void;
  isDestroyed(): boolean;
  destroy(): void;
}
```

**The provider is the primitive**, so `scene.primitives.add(provider)` works and
one `destroy()` tears down everything. That matters because we hold things
Cesium knows nothing about — a Worker pool, a budget, a registry, a Blob URL —
and if Cesium destroys the tileset without destroying us, Worker threads leak.
Exposing `tileset` keeps Decision 1 intact: styles, picking and traversal stay
Cesium's, and a caller reaches them the normal way.

`registerCrs` is a static because Decision 6 says so, and because it must be
callable **before** `fromUrl`; the README's first example is written in that
order for exactly that reason.

```ts
interface COPCTilesetProviderOptions {
  /** OVERVIEW §7, default 16. Cesium's own knob, passed straight through. */
  readonly maximumScreenSpaceError?: number;
  /** OVERVIEW §7, default 4. */
  readonly workerPoolSize?: number;
  /** How a Worker is made. Required until the bundling sub-project ships one. */
  readonly spawnWorker: () => WorkerPort;
}

interface ProviderStats {
  /** `RangeStats`: requests, retries, bytesRequested, bytesWasted, requestsSaved. */
  readonly range: RangeStats;
  /** `BudgetStats`: per-resource admitted/deferred/rejected, current and peak. */
  readonly budget: BudgetStats;
  /** Tiles whose content the synthetic document had to invent. */
  readonly synthesizedAncestors: number;
}
```

`stats()` is not decoration: §7 requires the Range merge's real waste ratio to
be *always* exposed, because the 2% waste cap is a knob that may only move on
measurement. `bytesWasted` over `bytesRequested` is that ratio, and this is
where a tuner reads it.

`extent` comes from the header's real min/max, not the octree cube — Decision 6
requires camera framing to use the measured extent rather than the inflated
one. It is a value rather than a `zoomTo()` method so the caller keeps control
of its own camera; `viewer.camera.flyTo({ destination: provider.extent })` is
their call to make.

## What `fromUrl` does, in order

1. `createRangeReader(url)` and `createBudget(limits)` — the limits are §7's,
   with `maximumScreenSpaceError` and the pool size taken from options.
2. `openCopc(reader)` — three requests, no more (§4), giving header, info, WKT
   and the root hierarchy page.
3. **Refuse a point format that carries no colour**, here, where the header is
   first read. COPC allows PDRF 6, 7 and 8 and only 7 and 8 carry RGB; today a
   PDRF-6 file reaches `src/worker/pnts.ts`'s `view.getter('Red')` and dies with
   copc.js's untyped `Error: No extractor for dimension: Red`. Decision 6 wants
   a typed error naming the file and the format, and it wants it before a globe
   loads rather than after the first tile decodes. This closes a
   `carried-forward.md` entry.
4. `findHorizontalEpsgCode(wkt)` then `resolveCrsDefinition(code)` — **once, on
   the main thread**, because those throw `CrsNotRegisteredError` and
   `CrsCodeNotFoundError` and they have to surface where `fromUrl` can reject.
   The resolved definition string is what the Worker pool is constructed with.
5. `measureRootGeometricError(header)` and a `tokenBase` unique to this
   provider.
6. `buildTileset(rootPage, context)` — the synthetic document and its registry.
7. A Blob URL for the JSON, and `Cesium3DTileset.fromUrl(resource, { skipLevelOfDetail, maximumScreenSpaceError })`
   where `resource` is the `ScheduledRangeResource` carrying that Blob URL —
   see the measured section: hand it the string instead and the interception
   never happens. §4's "revoke immediately" means after `fromUrl` resolves,
   which is after Cesium has awaited the JSON; revoking before that races the
   fetch it exists for.
8. Install the codec on `_runtimeContentCodec`.

### `tokenBase`, validated here or nowhere

`TilesetContext.tokenBase`'s contract — absolute with a scheme (Decision 2's
first constraint), trailing `/`, characters that survive URI normalisation,
stable and unique per provider — is documented on the type and enforced by
nothing. The provider is its only caller, so the check belongs here. A relative
prefix would silently produce relative content URIs, which is the exact failure
that constraint exists to name. Closes a `carried-forward.md` entry.

## The registry grows

A hierarchy tile's content is a page, and expanding it means calling
`buildTileset` **again** — Decision 2's second constraint met by re-entering one
function rather than by a second code path, which is how `src/tileset/` was
already written. So the provider owns a live registry that the codec adds to as
sub-pages open, and the hierarchy-page budget (§7: 64) applies to what it
retains.

`entry.kind` is what the codec branches on — never the URI's `n/` versus `h/`
prefix. They are redundant encodings of one fact and will eventually disagree.
Closes a `carried-forward.md` entry.

## Verification

Each is a property with a mutation that must redden it; a claim written without
running its mutation does not go in the report (CLAUDE.md).

**The interception**

1. `ScheduledRangeResource` survives `clone()` and `getDerivedResource()` as
   itself. Mutation: drop the `clone` override, and watch a derived resource
   become a plain `Resource`. This is the trap the measured section names.
2. `admitted` returns a promise resolving to the descriptor's bytes;
   `deferred` returns **`undefined`**, not a rejected promise and not a
   never-settling one; `rejected` returns a rejected promise carrying the typed
   error. All three asserted on the returned value, since the difference between
   them *is* the return value.
3. A URI with no registry entry fails with a typed error rather than reaching
   the network. Decision 4: no request built on a guess.

**The codec**

4. A point tile's bytes reach the Worker pool and the resulting content is what
   `Model3DTileContent.fromPnts` returned.
5. A hierarchy tile's bytes are parsed, `buildTileset` is re-entered, the new
   entries appear in the live registry, and `hasTilesetContent` is set — the
   flag whose absence stops a subtree opening at all.
6. `hasRenderableContent` is set for a point tile. Both flags asserted, because
   the early return means nothing else sets them.

**The provider**

7. `fromUrl` issues exactly three requests before the tileset exists (§4).
8. A PDRF-6 file is refused with a typed error naming the file and the format,
   before any tileset is built.
9. An unregistered CRS rejects `fromUrl` rather than failing later in a Worker.
10. A `tokenBase` that is relative, or missing its trailing `/`, is refused.
11. `destroy()` destroys the tileset, the Worker pool and the budget, revokes
    nothing that was already revoked, and is safe to call twice.
12. **The primitive surface matches what Cesium actually calls.** Scan
    `PrimitiveCollection.js` for the methods it invokes on a member and assert
    our provider implements exactly that set — the same offline-source-scan
    shape `tests/cesium-contract.test.ts` already uses, so a Cesium upgrade that
    adds a sixth method fails here rather than in a browser.

**Structural**

13. Nothing outside `src/cesium-runtime/` imports Cesium — the existing
    isolation rule, now with something to isolate.
14. `tests/cesium-contract.test.ts` keeps passing: it is the regression guard
    for every contract this design rests on.

## Risks

**Nothing here proves it renders.** Every verification above is offline. The
composition — Cesium traversing, selecting, requesting, and our bytes arriving
as pixels — is exactly what a browser gate is for, and it is the next piece of
work after this one. The measured section is the mitigation: every contract
this design depends on is read out of Cesium's own source and pinned by
`tests/cesium-contract.test.ts`, so an upgrade that breaks one fails offline.

**Traversal timing is untested.** `carried-forward.md` already asks when Cesium
fetches an external tileset whose placeholder shares its geometric error. That
question survives this sub-project: the gate proved the expansion path works,
not when it fires.

**The `deferred` → `undefined` mapping rests on one function.** It is Cesium's
documented behaviour and its own JSDoc, and `tests/cesium-contract.test.ts` is
where a version that changes it must be caught. Add an assertion there for the
`if (!defined(promise))` branch specifically.

## Decisions settled — do not relitigate mid-task

- The provider **is** the primitive; `fromUrl` returns it, not a bare tileset.
- `deferred` returns `undefined`. Not a rejection, not a pending promise.
- The codec branches on `entry.kind`, not on the URI prefix.
- Sub-page expansion re-enters `buildTileset`; there is no second builder.
- `resolveCrsDefinition` runs once, on the main thread, in `fromUrl`.
- The provider takes a Worker port factory; it does not construct a platform
  Worker.
- No browser test in this sub-project.
