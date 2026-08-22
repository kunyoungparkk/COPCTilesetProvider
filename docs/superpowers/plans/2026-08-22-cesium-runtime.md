# Cesium Runtime and Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `COPCTilesetProvider.fromUrl(url)` — the one line OVERVIEW §1 promises, and the library's first entry point.

**Architecture:** `src/cesium-runtime/` is the only module that imports Cesium. A `Resource` subclass intercepts virtual tile URIs and answers with the budget's own three-way verdict; a codec turns the bytes into Cesium content for both tile kinds; the provider assembles everything and *is* the primitive a caller adds to a scene, so one `destroy()` tears down the tileset, the Worker pool and the budget together.

**Tech Stack:** TypeScript 7 (ESM, `erasableSyntaxOnly`), Vitest, Cesium 1.143 as a peer, the existing `src/copc/`, `src/crs/`, `src/range/`, `src/budget/`, `src/tileset/` and `src/worker/` modules. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-22-cesium-runtime-design.md`

## Global Constraints

- **Node 22 is required.** The default `node` is v18 and Vitest dies at startup. Prefix every command with `export PATH=/home/kyp/.local/node22/bin:$PATH`.
- **No new dependencies.** OVERVIEW §5 fixes the runtime list at `copc.js`, `laz-perf`, `proj4`; `tests/manifest.test.ts` pins it. Cesium is a **peer** (`>=1.142.0 <1.144.0`), never a dependency.
- **Decision 2's isolation rule:** nothing outside `src/cesium-runtime/` may import Cesium or touch an underscore field. A boundary test enforces it (Task 6).
- **Tests never touch the network.** Committed fixtures under `fixtures/` only.
- **`tsc --noEmit` clean** under `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. Imports carry `.js`.
- **Green in all three isolation modes:** `npm test`, `npx vitest run --no-isolate`, `npx vitest run --no-isolate --fileParallelism=false`. All must exit cleanly.
- **English** for code, comments, commit messages. Commits `type(scope): summary`, imperative, under 72 chars; the body explains *why* and cites the OVERVIEW decision when one applies.
- **Two CLAUDE.md rules bind every task:** write what a test catches only after running the mutation that decides it; comments state what is true *now*, and history goes in the commit body — **never a pointer to `.superpowers/`, a design doc, a plan, or a test by number.** A stranger has none of those. Run `grep -rn "\.superpowers" src/ tests/` before every commit.
- **Do not edit `OVERVIEW.md`.** If you believe it needs changing, say so in your report.

## Numbers in this plan

Baseline: **395 tests / 36 files**, `tsc --noEmit` clean. Re-derive with `npm test`.

Every other figure is read from a file in the repository or comes with the command that produces it. Six hand-traced predictions in the previous sub-project's plan turned out wrong, every one found by an implementer running rather than transcribing.

## What was measured, and what it buys

Re-run these before relying on them.

**Both Cesium content factories work in Node, with no GL context.** Driving our own pipeline over the pinned chunk and handing the result to the real factory:

```
real PNTS bytes: 2024
fromPnts OK -> Model3DTileContent | featuresLength 0 | pointsLength 0
```

`featuresLength 0` is expected — the `Model` has not been processed yet, which needs a frame. What matters is that the content object constructs. `Tileset3DTileContent.fromJson` likewise runs and only needs a tileset fake carrying `loadTileset`.

So the codec's tests are not "assert we called the factory" but **"the real factory accepted our bytes"**, which is a much stronger claim and the reason no browser is needed for this sub-project.

**`Model3DTileContent` is a default export** (`Object.keys(module)` is `['default']`). Import it accordingly.

**The range reader does not take a budget.** `src/range/range-reader.ts:329` says the reader "only ever sees ranges the budget already approved" — so acquiring the Range lease is the interceptor's job, not the reader's.

**A PDRF-6 view really has no colour**, so Task 1's premise holds. Measured rather than read: `Las.View.create` over a header with each format, asking whether `Red` is among the view's dimensions —

```
pdrf 6 -> dimensions include Red? false
pdrf 7 -> dimensions include Red? true
pdrf 8 -> dimensions include Red? true
```

which matches `node_modules/copc/lib/las/extractor.js`: `create6` at line 162 names no colour, `create7` at 189 introduces `Red` at 193.

**The format byte is not the whole byte, and Task 1 has to know that.** `node_modules/copc/lib/las/header.js:33` reads it as `dv.getUint8(104) & 0b1111`. Autzen's raw byte at 104 is **135** — `0b10000111` — because the high bit is LAZ's compression flag. A test that rewrites the format by assigning `6` to that byte clears the flag as well, and the file then fails for a completely unrelated reason. Preserve the high bits: `(raw & 0b11110000) | 6`.

## One refinement to the spec, decided here

**The colourless-point-format check goes in `openCopc`, not in `fromUrl`.** The spec places it at step 3 of `fromUrl`; `carried-forward.md` says it belongs "where the header is first read", and that is literally `src/copc/open.ts`. Putting it there makes every caller safe rather than one, keeps the error with its siblings in `src/errors/copc.ts`, and costs nothing: the library needs RGB on every path, because `encodePnts` writes it unconditionally. A PDRF-6 file is unusable by this library whoever opens it.

## File Structure

- `src/errors/copc.ts` — **modify.** Add `UnsupportedPointFormatError` (Task 1).
- `src/copc/open.ts` — **modify.** Refuse a colourless format (Task 1).
- `src/cesium-runtime/resource.ts` — **create.** `ScheduledRangeResource` (Task 2).
- `src/cesium-runtime/codec.ts` — **create.** `createCodec` (Task 3).
- `src/cesium-runtime/provider.ts` — **create.** `COPCTilesetProvider` (Tasks 4 and 5).
- `src/cesium-runtime/index.ts`, `src/index.ts`, `package.json`, `src/cesium-runtime/README.md` — **create/modify** (Task 6).
- `tests/copc-open.test.ts` — **modify** (Task 1). New test files per task otherwise.

---

### Task 1: Refuse a point format that carries no colour

**Files:**
- Modify: `src/errors/copc.ts`, `src/errors/index.ts`, `src/copc/open.ts`, `tests/copc-open.test.ts`, `tests/errors.test.ts`

**Interfaces:**
- Produces: `class UnsupportedPointFormatError extends CopcTilesetError` with `code = 'unsupported-point-format'` and a readonly `pointDataRecordFormat: number`.

COPC allows point data record formats 6, 7 and 8; only 7 and 8 carry RGB (`node_modules/copc/lib/las/extractor.js`, `create6` has no `Red`/`Green`/`Blue` — confirm this). Today a PDRF-6 file reaches `src/worker/pnts.ts`'s `view.getter('Red')` and dies with copc.js's untyped `Error: No extractor for dimension: Red` — no file named, no format named, no guidance, against Decision 6's rule that errors are part of the API. And it dies per tile, in a Worker, after a globe has already loaded.

- [ ] **Step 1: Write the failing tests**

In `tests/copc-open.test.ts`, using the pinned Autzen head with its format byte rewritten at offset 104 — and **preserving that byte's high bits**, which carry LAZ's compression flag (see *What was measured*). Assigning `6` outright clears it and the file fails for an unrelated reason, which is a green test proving nothing.

1. A file whose `pointDataRecordFormat` is 6 is refused by `openCopc`, with `code: 'unsupported-point-format'`, and the message names the file's URL and the number 6.
2. Formats 7 and 8 open normally. Autzen is 7, so 8 is the one to construct.
3. The refusal happens **before** the hierarchy is read — assert on the recorded reads, not just on the throw. This is what makes it an open-time refusal rather than a late one.

In `tests/errors.test.ts`, the house-convention entry for the new error: stable `code`, `name`, base type, and message substrings.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

```ts
/**
 * The file's points carry no colour.
 *
 * COPC allows point data record formats 6, 7 and 8, and only 7 and 8 have RGB
 * (`copc.js`'s own extractor for format 6 exposes no `Red`, `Green` or `Blue`).
 * This library encodes `RGB` into every PNTS tile, so a format-6 file has
 * nothing to render from — and refusing at open is the difference between one
 * error naming the file and one untyped throw per tile, inside a Worker,
 * after the globe has loaded.
 */
export class UnsupportedPointFormatError extends CopcTilesetError {
  readonly code = 'unsupported-point-format';
  readonly pointDataRecordFormat: number;

  constructor(url: string, pointDataRecordFormat: number) {
    super(
      `${url} uses point data record format ${pointDataRecordFormat}, which carries no ` +
        'colour. This library needs RGB, so only formats 7 and 8 can be rendered. ' +
        'Re-writing the file with a current PDAL — `pdal translate input.laz ' +
        'output.copc.laz --writers.copc.forward=all` from a source that has colour — ' +
        'produces a format this library can read.',
    );
    this.pointDataRecordFormat = pointDataRecordFormat;
  }
}
```

In `openCopc`, after `readFileHeader` and before anything else uses the header.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Accept format 6. Expected: test 1 reddens.
2. Refuse format 7. Expected: test 2 reddens — the check must not be an accidental allow-list of one.
3. Move the check after `readHierarchyPage`. Expected: test 3 reddens while 1 and 2 stay green. If test 3 does **not** redden, it is not asserting what it claims.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(copc): refuse a point format that carries no colour"
```

---

### Task 2: `ScheduledRangeResource`

**Files:**
- Create: `src/cesium-runtime/resource.ts`
- Test: `tests/cesium-resource.test.ts`

**Interfaces:**
- Produces:

```ts
export interface InterceptContext {
  readonly reader: RangeReader;
  readonly budget: Budget;
  /**
   * The provider's live registry. Held by reference, never copied: the codec
   * adds to this map as sub-pages open, and a copy would make every entry
   * after the root page invisible — a defect that would surface one task later
   * and look like the codec's.
   */
  readonly entries: ReadonlyMap<string, TileEntry>;
  /** Distinguishes "ours but unknown" from "not ours at all". */
  readonly tokenBase: string;
  readonly url: string;
}

export class ScheduledRangeResource extends Resource {
  constructor(options: { url: string }, context: InterceptContext);
  override clone(result?: Resource): Resource;
  override fetchArrayBuffer(): Promise<ArrayBuffer> | undefined;
}
```

**Two things here will silently destroy the design if got wrong**, both measured in the spec:

1. **`clone` must be overridden.** `Resource.prototype.clone(result)` returns a plain `new Resource` when `result` is missing, and both `getDerivedResource` and `Cesium3DTile`'s `tile._contentResource.clone()` go through it. A subclass that does not override `clone` is downgraded before its first use. `Core/IonResource.js:175-187` is the first-party pattern: build yourself when `result` is missing, then `Resource.prototype.clone.call(this, result)`, then copy your own fields onto the result.
2. **A miss delegates to `super`.** The tileset JSON is fetched through this same resource (the tileset is created from it, not from the Blob URL string), so anything that is not a registry hit must reach `super.fetchArrayBuffer()`.

- [ ] **Step 1: Write the failing tests**

1. `clone()` returns a `ScheduledRangeResource`, and so does `getDerivedResource({ url: 'copc://a1b2c3/n/0-0-0-0' })`. Assert `instanceof`, and assert the clone still resolves a registry hit — a clone that is the right class but lost its context is the same failure one step later.
2. A registry hit whose budget admits returns a promise resolving to exactly the descriptor's bytes.
3. A registry hit whose budget **defers** returns `undefined`. Assert `toBeUndefined()`, not falsiness — `null` and a rejected promise are both wrong and both falsy-adjacent.
4. A registry hit whose budget **rejects** returns a rejected promise carrying a typed error.
5. A URL that is not in the registry and is not the tileset's own delegates to `super.fetchArrayBuffer()` — assert the injected `fetch` saw it.
6. A URL under `tokenBase` that the registry does not know fails with a typed error rather than reaching `super` — Decision 4: no request built on a guess.
7. The Range lease is released on every path: resolve, reject, and a `super` delegation that throws.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

The `clone` override, which is the piece worth writing out:

```ts
/**
 * Keeps derived resources in this class.
 *
 * `Resource.prototype.clone` builds a plain `Resource` when handed no result,
 * and Cesium derives every tile's content resource from the tileset's
 * (`Cesium3DTile.js`, `baseResource.getDerivedResource(...)`) and clones it
 * again before each request. Without this override the interception is gone
 * before the first tile, and `copc://…` reaches the network. `IonResource`
 * overrides `clone` for the same reason.
 */
override clone(result?: Resource): Resource {
  const target = result ?? new ScheduledRangeResource({ url: this.url }, this.#context);
  const cloned = Resource.prototype.clone.call(this, target) as ScheduledRangeResource;
  cloned.#context = this.#context;
  return cloned;
}
```

`fetchArrayBuffer` in order: miss → `super`; hit under `tokenBase` with no entry → typed error; hit → `budget.acquireRangeRequest(origin, entry.length)` → `admitted` reads through the reader and releases the lease exactly once, `deferred` returns `undefined` **and releases nothing because nothing was acquired**, `rejected` returns a rejected promise.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Delete the `clone` override. Expected: test 1 reddens on `instanceof`.
2. Keep the override but drop the context copy. Expected: test 1's second half reddens — this is why that half exists.
3. Return `null` instead of `undefined` for `deferred`. Expected: test 3 reddens. If it does not, the assertion is `toBeFalsy` in disguise.
4. Return a rejected promise for `deferred`. Expected: test 3 reddens.
5. Let an unknown URI under `tokenBase` fall through to `super`. Expected: test 6 reddens.
6. Release the lease twice on the resolve path. Expected: `LeaseAlreadyReleasedError` reddens test 7.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cesium): answer tile requests with the budget's verdict"
```

---

### Task 3: The codec

**Files:**
- Create: `src/cesium-runtime/codec.ts`
- Test: `tests/cesium-codec.test.ts`

**Interfaces:**
- Consumes: `WorkerPool` from `src/worker/pool.js`, `buildTileset` from `src/tileset/index.js`, `readHierarchyPage`'s parsing (see below).
- Produces: `createCodec(context: CodecContext): RuntimeContentCodec`, where the codec object's shape is Cesium's: `{ contentType, createContent }`.

Decision 2's second constraint is the whole of this task's risk. The codec branch in `Cesium3DTile.makeContent` returns **before** `preprocess3DTileContent`, so everything that call would have classified is the codec's to set: `hasTilesetContent` and `hasRenderableContent` on the tile. Miss `hasTilesetContent` on a hierarchy tile and the subtree never opens.

The codec branches on `entry.kind`, never on the URI's `n/` versus `h/` prefix — they are redundant encodings of one fact and will eventually disagree.

- [ ] **Step 1: Write the failing tests**

Both content factories run in Node (see *What was measured*). `Model3DTileContent` is a **default** export; reach it and `Tileset3DTileContent` by the house convention in `tests/cesium-contract.test.ts` (`createRequire` + deep dynamic import), never a bare `@cesium/engine` import.

1. A point tile: the pinned chunk's bytes go through the codec, the Worker pool encodes them, and the value returned is what `Model3DTileContent.fromPnts` produced — assert `instanceof` the real class, over the real 2024-byte PNTS.
2. That tile has `hasRenderableContent === true`.
3. A hierarchy tile: the page's bytes are parsed, `buildTileset` is re-entered, and the **live registry gains** the new page's entries — assert a specific new URI is present that was absent before.
4. That tile has `hasTilesetContent === true`. Mutate it away and watch this redden; it is the flag whose absence stops a subtree opening at all.
5. The codec branches on `entry.kind`: give a `points` entry a URI with an `h/` prefix and assert it is still encoded as points.
6. An entry the registry does not have raises a typed error rather than returning `undefined` — Cesium would treat `undefined` as a destroyed tile.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Compose. The hierarchy path parses the page with the same `readHierarchyPage`-shaped code the rest of the library uses — **it must not re-fetch**, because the bytes are already in hand; if `readHierarchyPage` cannot be reused without a reader, say so in your report and extract the parsing rather than duplicating it.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Do not set `hasTilesetContent`. Expected: test 4 reddens.
2. Do not set `hasRenderableContent`. Expected: test 2 reddens.
3. Branch on the URI prefix instead of `entry.kind`. Expected: test 5 reddens.
4. Return the raw `ArrayBuffer` instead of the content object. Expected: test 1 reddens on `instanceof`.
5. Build the sub-page's tileset but do not merge its entries into the live registry. Expected: test 3 reddens.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cesium): build tile content for both tile kinds"
```

---

### Task 4: `fromUrl`

**Files:**
- Create: `src/cesium-runtime/provider.ts`
- Test: `tests/cesium-provider.test.ts`

**Interfaces:**
- Produces: `COPCTilesetProvider.fromUrl(url, options)` and `COPCTilesetProvider.registerCrs`, plus `COPCTilesetProviderOptions` and `ProviderStats` as the spec declares them.

The order is the spec's: reader and budget; `openCopc`; horizontal EPSG code then `resolveCrsDefinition` **once, on the main thread** (those errors have to surface where `fromUrl` can reject, and a Worker's copy of the registry would hold nothing); `measureRootGeometricError`; a `tokenBase`; `buildTileset`; a Blob URL; `Cesium3DTileset.fromUrl(resource, …)` where `resource` is the `ScheduledRangeResource` **carrying that Blob URL** — hand it the string and the interception never happens; revoke the Blob URL after `fromUrl` resolves, not before; install the codec.

**`tokenBase` is validated here or nowhere.** Its contract — absolute with a scheme (Decision 2's first constraint), trailing `/`, characters that survive URI normalisation, stable and unique per provider — is documented on `TilesetContext` and enforced by nothing. The provider is its only caller.

Because the provider both generates and validates it, **the validator is a named exported function**, tested directly. An inline check can only be reached by smuggling an invalid value into a function that never accepts one from outside, which is how a test becomes a mock that proves nothing.

- [ ] **Step 1: Write the failing tests**

1. `fromUrl` issues exactly three requests before the tileset exists — assert the recorded ranges, matching `tests/copc-open.test.ts`'s existing shape (§4).
2. A file whose CRS is not registered rejects `fromUrl` with `CrsNotRegisteredError`, and the message carries the code and a copy-pasteable `registerCrs` call (Decision 6).
3. A file whose WKT names no horizontal code rejects with `CrsCodeNotFoundError`.
4. Two providers built from the same file get different `tokenBase` values — the registry keys are built from it, so a collision would cross-wire two tilesets.
5. A `tokenBase` that is relative, or lacks its trailing `/`, is refused with a typed error. Generate the valid one internally; this test exercises the validator directly.
6. `provider.extent` comes from the header's measured min/max, not the octree cube. Assert against the pinned Autzen header's own numbers, and say in your report where you got them.
7. `maximumScreenSpaceError` reaches the tileset, defaulting to §7's 16.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Resolve the CRS lazily, inside the Worker init instead of in `fromUrl`. Expected: tests 2 and 3 redden — the error must arrive where `fromUrl` can reject.
2. Give both providers the same `tokenBase`. Expected: test 4 reddens.
3. Revoke the Blob URL before `Cesium3DTileset.fromUrl` is awaited. Expected: report what actually happens. It may or may not fail in Node without a real fetch of the Blob; if it does not, say so plainly rather than claiming coverage.
4. Pass the Blob URL string to `Cesium3DTileset.fromUrl` instead of the resource. Expected: report what reddens. **If nothing does, that is the most important finding in this task** — it is the failure the spec's measured section says is silent, and it would mean no test in this plan catches it.
5. Use the octree cube for `extent`. Expected: test 6 reddens.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cesium): assemble a provider from a COPC url"
```

---

### Task 5: The primitive surface, `destroy`, and `stats`

**Files:**
- Modify: `src/cesium-runtime/provider.ts`
- Test: `tests/cesium-provider-lifetime.test.ts`

The provider **is** the primitive, so `scene.primitives.add(provider)` works and one `destroy()` tears down everything. That matters because we hold what Cesium knows nothing about — a Worker pool, a budget, a registry, a Blob URL — and if Cesium destroys the tileset without destroying us, Worker threads leak.

- [ ] **Step 1: Write the failing tests**

1. Each of the five delegated methods forwards to the tileset, with its arguments, exactly once.
2. **The delegated set matches what Cesium actually calls.** Scan `node_modules/@cesium/engine/Source/Scene/PrimitiveCollection.js` for the methods it invokes on a member and assert our provider implements exactly that set — the same offline-source-scan shape `tests/cesium-contract.test.ts` uses. Measured today: `update`, `updateForPass`, `prePassesUpdate`, `postPassesUpdate`, `destroy`. Re-derive the list rather than hard-coding it, so a Cesium upgrade that adds a sixth method fails here instead of in a browser. **Guard the guard:** assert the scanned set is non-empty, or a regex that stops matching passes vacuously.
3. `destroy()` destroys the tileset, destroys the Worker pool, destroys the budget, and revokes the Blob URL if it is still held.
4. `destroy()` is safe to call twice, and `isDestroyed()` reports correctly across both calls.
5. Calling a delegated method after `destroy()` does not throw from inside Cesium — decide the behaviour, state it in the doc comment, and pin it.
6. `stats()` surfaces the Range stats, the budget stats, and `synthesizedAncestors`. §7 requires the merge's real waste ratio to be *always* exposed, so `bytesWasted` and `bytesRequested` must both be reachable.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Drop one delegated method. Expected: tests 1 and 2 both redden.
2. Add a delegated method Cesium does not call. Expected: test 2 reddens — the assertion is an equality, not a superset.
3. Skip the Worker pool in `destroy()`. Expected: test 3 reddens. This is the leak the whole design decision exists to prevent, so watch it go red specifically.
4. Make `destroy()` throw on a second call. Expected: test 4 reddens.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cesium): own every resource the tileset does not"
```

---

### Task 6: The entry point, the manifest, and the boundary

**Files:**
- Create: `src/cesium-runtime/index.ts`, `src/index.ts`, `src/cesium-runtime/README.md`
- Modify: `package.json`, `tests/cesium-contract.test.ts`
- Test: `tests/cesium-boundary.test.ts`

This is the library's first entry point: `src/index.ts` does not exist and `package.json` declares no `exports`, `main` or `types`.

- [ ] **Step 1: The barrel and the entry point**

`src/index.ts` exports `COPCTilesetProvider` and the option and stats types, plus every typed error a caller can catch — errors are part of the API (Decision 6), and a caller cannot branch on a class it cannot import.

`package.json` gains `exports` and `types`. **Do not add a `main`** unless you can say why; this is ESM-only. Note that `docs/superpowers/` currently ships to consumers because there is no `files` field — `carried-forward.md` records that as the publish sub-project's item, so leave it, but check the entry point you add does not make it worse.

- [ ] **Step 2: The boundary test**

`tests/cesium-boundary.test.ts`, using `tests/import-closure.ts`:

- The closure of `src/index.ts` **must** contain `cesium-runtime/provider.ts` and `worker/pool.ts` — without the positive half the exclusions below can pass on an empty result.
- No module **outside** `src/cesium-runtime/` may import `cesium` or `@cesium/engine`. Walk every file under `src/`, exclude `src/cesium-runtime/`, and assert none of them names either specifier. Decision 2's isolation rule, enforced rather than documented.

Note the closure walker refuses a closure it cannot resolve, so an assertion cannot pass vacuously — but **run the mutations anyway**: an assertion that has never failed is one nobody has tested, and that shape has cost this project seven findings.

- [ ] **Step 3: Extend the contract test**

`tests/cesium-contract.test.ts` is the offline regression guard for every Cesium contract this design rests on. Add the one this sub-project newly depends on: the `if (!defined(promise))` branch in `Cesium3DTile.js`'s content request path, which is what makes `deferred` mean "re-ask next frame" rather than "failed". A Cesium version that changes it must fail here.

- [ ] **Step 4: The README**

Three parts, like `src/range/README.md` and `src/crs/README.md`: what the module does, the three constraints Decision 2's early return imposes and how each is met, and the limits worth knowing — that nothing here is proved to render, and that the Worker port factory is required until the bundling sub-project ships one.

**Check every sentence against the code and `grep` every symbol you name.**

- [ ] **Step 5: Mutations**

1. Import `cesium` from a file outside `src/cesium-runtime/`. Expected: the isolation assertion reddens and names the file.
2. Remove `cesium-runtime/provider.ts` from `src/index.ts`'s exports. Expected: the positive assertion reddens.
3. Break the contract test's new assertion by pointing it at a string Cesium does not contain. Expected: it reddens rather than passing on an empty search.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: expose COPCTilesetProvider as the library entry point"
```

---

## Done when

- `COPCTilesetProvider.fromUrl(url)` opens a COPC file in three requests, builds a synthetic tileset, and installs a codec on a real `Cesium3DTileset`.
- A tile request that the budget admits resolves with the descriptor's bytes; one it defers returns `undefined`, which Cesium reads as "re-ask next frame"; one it rejects fails the tile.
- A derived tile resource is still a `ScheduledRangeResource`.
- The real `Model3DTileContent.fromPnts` accepts the bytes our pipeline produces, and the real `Tileset3DTileContent.fromJson` accepts the document our builder produces.
- `hasRenderableContent` and `hasTilesetContent` are set by the codec, because the early return means nothing else does.
- A colourless point format is refused at open, naming the file and the format.
- An unregistered CRS rejects `fromUrl` rather than failing later inside a Worker.
- One `destroy()` releases the tileset, the Worker pool, the budget and the Blob URL, twice-safely.
- Nothing outside `src/cesium-runtime/` imports Cesium, asserted.
- The library has an entry point, and `package.json` says where it is.

## Self-review

**Spec coverage.** Interception → Task 2; the codec and both tile kinds → Task 3; `fromUrl`'s order, `tokenBase`, CRS-at-open → Task 4; the primitive surface, `destroy`, `stats` → Task 5; entry point, isolation, contract guard, README → Task 6; the colourless-format refusal → Task 1. The spec's verification list maps one-to-one onto these tasks' tests.

**Placeholder scan.** Every step names the file, the assertion and the mutation. Two places deliberately ask the implementer to *report* rather than assert a predicted outcome — Task 4's mutations 3 and 4 — because I do not know what happens in Node without a real Blob fetch, and guessing there is how six numbers in the previous plan turned out wrong.

**Type consistency.** `InterceptContext`, `ScheduledRangeResource` (Task 2) are consumed by Task 4. `createCodec`/`CodecContext` (Task 3) by Task 4. `COPCTilesetProviderOptions`, `ProviderStats` are declared in the spec and used in Tasks 4-6. `TileEntry`, `WorkerPool`, `Budget`, `RangeReader` come from existing modules unchanged.

**The risk this plan does not close.** Nothing here proves it renders. Task 4's mutation 4 is the closest thing to a canary: if handing `Cesium3DTileset.fromUrl` a string instead of our resource reddens nothing, then the design's most silent failure mode is untested, and that should be reported loudly rather than passed over.
