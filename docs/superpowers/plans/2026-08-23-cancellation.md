# Cancellation and the Hierarchy Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close both of carried-forward's `src/cesium-runtime/` items — cancel a
Range read when Cesium cancels its tile, and stop pretending there is a
hierarchy-page budget.

**Architecture:** Cesium hands `ScheduledRangeResource` the very `Request`
object its own `cancelRequests()` cancels, and `Request.cancel()` only sets a
flag — so one small module wraps that instance method and turns it into an
`AbortSignal` the existing `RangeReader.read(range, signal)` already knows what
to do with. The unenforceable hierarchy counter is removed from the `Budget`
API and replaced by two numbers `stats()` can actually measure.

**Tech Stack:** TypeScript 7, Vitest 4, Cesium 1.143 internals confined to
`src/cesium-runtime/` and pinned by `tests/cesium-contract.test.ts`.

**Spec:** `docs/superpowers/specs/2026-08-23-cancellation-design.md`

## Global Constraints

- Cesium internals are reachable **only** from `src/cesium-runtime/`
  (OVERVIEW §3, Decision 2). Every new dependence on one gets an assertion in
  `tests/cesium-contract.test.ts`.
- **Do not cancel decode jobs.** Cesium's `makeContent` catch does not check
  `request.cancelled` and sends the tile to `FAILED`, which is terminal here.
  Aborting a decode trades a worker slot for a permanently dead tile.
- Decision 5: every lease returns exactly once on every path — success,
  failure, cancellation, destroy.
- Decision 6: errors are API. Anything new that throws says what the caller
  must do.
- Comments state what is true now. A change that falsifies a comment fixes it
  in the same commit.
- English for code, comments, commits, errors. Korean only for `OVERVIEW.md`
  and `docs/superpowers/`.
- Node lives at `~/.local/node22/bin` — put it on `PATH` or `npm test` dies at
  startup (default `node` is v18).
- `npm test` must stay offline and buildless.

---

### Task 1: retire the hierarchy budget

`Budget.acquireHierarchyPage()` has no caller in `src/`, and the thing §7's
knob claims to bound — retained parsed pages — does not exist: the codec
parses a page, copies the `TileEntry` values out, and drops the page. This
task removes the counter and puts two measurable numbers in its place.

**Files:**
- Modify: `src/budget/budget.ts` (the interface, the class, `BudgetStats`, `BudgetLimits`)
- Modify: `src/cesium-runtime/provider.ts` (`ProviderStats`, the constructor, `stats()`)
- Modify: `src/cesium-runtime/codec.ts` (`CodecContext`, the expansion branch)
- Modify: `src/budget/README.md`
- Modify: `OVERVIEW.md` (§7's knob table)
- Test: `tests/budget-verdicts.test.ts` (drop the `acquireHierarchyPage` block)
- Test: `tests/cesium-resource.test.ts` (the fake budget)
- Test: `tests/cesium-provider.test.ts` (new stats assertions)

**Interfaces:**
- Produces: `ProviderStats.registryEntries: number` and
  `ProviderStats.hierarchyPagesExpanded: number`.
- Produces: `CodecContext.hierarchyPagesExpanded: { count: number }` — a boxed
  counter, held by reference exactly as `synthesizedAncestors` already is.
- Removes: `Budget.acquireHierarchyPage()`, `BudgetStats.hierarchy`,
  `BudgetLimits.hierarchyPages`, `DEFAULT_HIERARCHY_PAGES`.

- [ ] **Step 1: Write the failing test**

Add to `tests/cesium-provider.test.ts`, inside the describe that already builds
a live provider (read the file first and follow its fixture helpers):

```ts
  it('measures the registry it actually keeps, not a page cache it does not', async () => {
    const provider = await COPCTilesetProvider.fromUrl(FILE_URL, {
      spawnWorker: createNodeWorkerPort,
      fetch: autzenFetch(),
    });
    try {
      const stats = provider.stats();
      // The root page's own entries are in the registry before any tile is
      // requested — `fromUrl` builds the tileset from it.
      expect(stats.registryEntries).toBeGreaterThan(0);
      // Nothing has expanded a sub-page yet.
      expect(stats.hierarchyPagesExpanded).toBe(0);
      // The counter that measured nothing is gone.
      expect('hierarchy' in stats.budget).toBe(false);
    } finally {
      provider.destroy();
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=~/.local/node22/bin:$PATH npx vitest run tests/cesium-provider.test.ts`
Expected: FAIL — `registryEntries` and `hierarchyPagesExpanded` are undefined,
and `'hierarchy' in stats.budget` is still true.

- [ ] **Step 3: Remove the counter from the budget**

In `src/budget/budget.ts`: delete `acquireHierarchyPage()` from the `Budget`
interface and the class, delete the `hierarchy` field from `BudgetStats` and
the `hierarchy: Counter` member, delete `hierarchyPages` from `BudgetLimits`,
delete `DEFAULT_HIERARCHY_PAGES`, and remove `hierarchy: this.hierarchy.stats()`
from `stats()`.

- [ ] **Step 4: Count what the codec actually does**

In `src/cesium-runtime/codec.ts`, add to `CodecContext`:

```ts
  /**
   * How many hierarchy sub-pages this codec has expanded, boxed and held by
   * reference for the same reason `synthesizedAncestors` is: `stats()` reads
   * the live total through the one object this module keeps adding to.
   *
   * A count of pages, not of retained pages — nothing retains a parsed page.
   * What survives an expansion is the `TileEntry` values it contributed to
   * `entries`, and `ProviderStats.registryEntries` is where those are counted.
   */
  readonly hierarchyPagesExpanded: { count: number };
```

and increment it in the hierarchy branch, beside the existing
`context.synthesizedAncestors.count += built.synthesizedAncestors;`:

```ts
      context.hierarchyPagesExpanded.count += 1;
```

- [ ] **Step 5: Expose both numbers**

In `src/cesium-runtime/provider.ts`, add to `ProviderStats`:

```ts
  /**
   * Tile descriptors the registry holds right now.
   *
   * It only grows. An entry cannot be dropped: Cesium re-requests an unloaded
   * tile by the same URI, and a missing entry throws
   * `UnknownTileRequestError`, which fails the tile terminally. Bounding this
   * would need an eviction policy keyed on Cesium's content lifecycle, and
   * nothing has measured a need for one — this number is how that would first
   * be noticed.
   */
  readonly registryEntries: number;
  /** Hierarchy sub-pages expanded so far. Only grows. */
  readonly hierarchyPagesExpanded: number;
```

Create the boxed counter next to the existing one (around `provider.ts:306`),
thread it into `CodecContext` and into the constructor's `init` the same way
`synthesizedAncestors` is threaded, keep the `Map` on a private field, and
return both from `stats()`:

```ts
      registryEntries: this.#entries.size,
      hierarchyPagesExpanded: this.#hierarchyPagesExpanded.count,
```

- [ ] **Step 6: Update the tests that named the removed API**

`tests/budget-verdicts.test.ts` has a `describe('acquireHierarchyPage', ...)`
block and a destroyed-budget assertion naming it — delete both. Read the file
first: the destroyed-budget test asserts several resources at once, so remove
only the hierarchy line, not the test.

`tests/cesium-resource.test.ts` has a fake budget with an
`acquireHierarchyPage` member — delete that member. The fake must still
satisfy `Budget`, which no longer declares it.

- [ ] **Step 7: Run the suite**

Run: `PATH=~/.local/node22/bin:$PATH npm test && PATH=~/.local/node22/bin:$PATH npm run typecheck`
Expected: green. Typecheck is what proves no caller of the removed API is left.

- [ ] **Step 8: Retire the §7 knob**

In `OVERVIEW.md`, delete the `예산 상한: hierarchy 페이지 캐시 | 64개` row and
add a short note under the table, in Korean, saying that the knob was retired
rather than tuned, and why: 파싱된 페이지는 보관되지 않고 파생된 `TileEntry`만
남으며, Cesium이 언로드된 타일을 같은 URI로 다시 요청하므로 그 entry는 버릴 수
없다. 대신 `stats()`의 `registryEntries`와 `hierarchyPagesExpanded`가 실제
성장을 노출한다.

Also update `src/budget/README.md` wherever it describes three resources or
names the hierarchy page budget.

- [ ] **Step 9: Mutation-check the new assertions**

Make `hierarchyPagesExpanded` return a literal `0` instead of the counter and
re-run `tests/cesium-provider.test.ts`. Expected: the fresh-provider test still
passes (it asserts 0) — which means **that assertion alone does not pin the
counter.** Add a second case that expands a sub-page and asserts the count
rises, using the multi-page fixture `tests/cesium-codec.test.ts` already
builds; read that file and reuse its page builder rather than writing a new
one. Re-run the mutation against the new case and confirm it fails. Record
both outcomes in the report.

- [ ] **Step 10: Commit**

```bash
git add src/budget/budget.ts src/budget/README.md src/cesium-runtime/provider.ts \
        src/cesium-runtime/codec.ts tests/budget-verdicts.test.ts \
        tests/cesium-resource.test.ts tests/cesium-provider.test.ts OVERVIEW.md
git commit -m "refactor(budget): retire the hierarchy budget for a real count"
```

---

### Task 2: turn Cesium's cancellation into an AbortSignal

`requestSingleContent` sets `resource.request = request` immediately before
calling `fetchArrayBuffer()`, and `Request.prototype.cancel` sets
`this.cancelled = true` and nothing else. This task is the one module that
knows both facts.

**Files:**
- Create: `src/cesium-runtime/cancellation.ts`
- Test: `tests/cesium-cancellation.test.ts`

**Interfaces:**
- Produces: `signalForRequest(request: unknown): AbortSignal | undefined`.

- [ ] **Step 1: Write the failing test**

`tests/cesium-cancellation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { signalForRequest } from '../src/cesium-runtime/cancellation.js';

/** The two members of Cesium's `Request` this module touches, and nothing else. */
function fakeRequest() {
  return {
    cancelled: false,
    cancel(this: { cancelled: boolean }) {
      this.cancelled = true;
    },
  };
}

describe('signalForRequest', () => {
  it('fires when Cesium cancels the request', () => {
    const request = fakeRequest();
    const signal = signalForRequest(request);
    expect(signal?.aborted).toBe(false);
    request.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it('leaves the request cancelled the way Cesium expects', () => {
    // Cesium's own `processArrayBuffer` reads `request.cancelled` to decide
    // whether a rejected fetch means "failed" or "try again later". Wrapping
    // `cancel` must not cost that.
    const request = fakeRequest();
    signalForRequest(request);
    request.cancel();
    expect(request.cancelled).toBe(true);
  });

  it('does not fire on its own', () => {
    const request = fakeRequest();
    expect(signalForRequest(request)?.aborted).toBe(false);
  });

  it('wraps once, however many times it is asked', () => {
    const request = fakeRequest();
    const first = signalForRequest(request);
    const wrapped = request.cancel;
    const second = signalForRequest(request);
    expect(second).toBe(first);
    expect(request.cancel).toBe(wrapped);
  });

  it('returns an already-aborted signal for an already-cancelled request', () => {
    const request = fakeRequest();
    request.cancel();
    expect(signalForRequest(request)?.aborted).toBe(true);
  });

  it('returns undefined when there is no request to watch', () => {
    // `fetchArrayBuffer` is reachable outside a tile request — a caller
    // fetching the resource directly has no Cesium `Request` at all. No
    // signal is the honest answer, and the read proceeds uncancellable.
    expect(signalForRequest(undefined)).toBeUndefined();
    expect(signalForRequest({})).toBeUndefined();
    expect(signalForRequest({ cancel: 'not a function' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=~/.local/node22/bin:$PATH npx vitest run tests/cesium-cancellation.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

`src/cesium-runtime/cancellation.ts`:

```ts
/**
 * Cesium's tile cancellation, as an `AbortSignal`.
 *
 * `Cesium3DTileset` cancels a tile that is still `LOADING` after a frame out
 * of view, which reaches `Cesium3DTile.cancelRequests` and then
 * `Request.prototype.cancel` — a method whose entire body is
 * `this.cancelled = true`. Nothing else happens: `RequestScheduler`'s
 * `cancelFunction` never runs for our requests, because
 * `ScheduledRangeResource.fetchArrayBuffer` overrides Cesium's own and never
 * enters the scheduler. So the only moment available is the `cancel` call
 * itself, and this wraps it.
 *
 * The wrap goes on the instance, not the prototype: every other request in the
 * application keeps the method it had. Cesium builds a fresh `Request` per
 * tile request (`Cesium3DTile.js`, `requestSingleContent`), so each one is
 * wrapped at most once and is garbage with its tile.
 *
 * Aborting a Range read is safe in a way aborting a decode is not: Cesium's
 * catch around the request promise checks `request.cancelled` and restores the
 * tile's previous state, while its catch around `makeContent` does not and
 * fails the tile terminally. `tests/cesium-contract.test.ts` pins both.
 */

/** Marks a request whose `cancel` this module has already wrapped. */
const SIGNAL = Symbol.for('copc-tileset-provider.cancellation');

interface CancellableRequest {
  cancelled?: boolean;
  cancel(): void;
  [SIGNAL]?: AbortSignal;
}

function isCancellable(request: unknown): request is CancellableRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    typeof (request as { cancel?: unknown }).cancel === 'function'
  );
}

/**
 * An `AbortSignal` that fires when Cesium cancels `request`, or `undefined`
 * when there is no request to watch — which is not an error: a resource
 * fetched outside a tile request has none, and that read is simply not
 * cancellable.
 */
export function signalForRequest(request: unknown): AbortSignal | undefined {
  if (!isCancellable(request)) return undefined;

  const existing = request[SIGNAL];
  if (existing !== undefined) return existing;

  const controller = new AbortController();
  request[SIGNAL] = controller.signal;

  if (request.cancelled === true) {
    controller.abort();
    return controller.signal;
  }

  const cancel = request.cancel.bind(request);
  request.cancel = () => {
    // Cesium's own behaviour first: `processArrayBuffer` reads `cancelled` to
    // tell "try again later" from "failed", so it has to be set either way.
    cancel();
    controller.abort();
  };

  return controller.signal;
}
```

- [ ] **Step 4: Run the test**

Run: `PATH=~/.local/node22/bin:$PATH npx vitest run tests/cesium-cancellation.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Mutation-check the two assertions that could be vacuous**

Run each, confirm the named test fails, then undo:

1. Drop the `cancel()` call from the wrapper (abort only) → expect "leaves the
   request cancelled the way Cesium expects" to FAIL.
2. Remove the `existing` early return → expect "wraps once, however many times
   it is asked" to FAIL.

Record both outcomes. Either that passes is an assertion checking nothing.

- [ ] **Step 6: Commit**

```bash
git add src/cesium-runtime/cancellation.ts tests/cesium-cancellation.test.ts
git commit -m "feat(cesium): read Cesium's tile cancellation as an AbortSignal"
```

---

### Task 3: cancel the Range read

**Files:**
- Modify: `src/cesium-runtime/resource.ts` (`fetchArrayBuffer`, `#readAdmitted`)
- Test: `tests/cesium-resource.test.ts`

**Interfaces:**
- Consumes: `signalForRequest(request)` from Task 2.
- Consumes: `RangeReader.read(range, signal?)`, which already shares the
  caller's signal with the in-flight fetch's controller
  (`src/range/range-reader.ts`).

- [ ] **Step 1: Write the failing test**

Add to `tests/cesium-resource.test.ts` — read the file first and reuse its
existing fake budget and reader helpers rather than writing new ones:

```ts
  it('aborts the read when Cesium cancels the tile, and returns the lease', async () => {
    let seen: AbortSignal | undefined;
    const reader = {
      read: (_range: ByteRange, signal?: AbortSignal) =>
        new Promise<RangeRead>((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      readMany: () => Promise.reject(new Error('not used')),
      stats: () => EMPTY_RANGE_STATS,
    };
    const resource = new ScheduledRangeResource({ url: POINT_URI }, contextWith(reader));
    // Cesium assigns this immediately before calling fetchArrayBuffer.
    const request = { cancelled: false, cancel(this: { cancelled: boolean }) { this.cancelled = true; } };
    (resource as unknown as { request: unknown }).request = request;

    const promise = resource.fetchArrayBuffer();
    expect(seen).toBeDefined();
    request.cancel();

    await expect(promise).rejects.toThrow();
    // Decision 5: the lease returns on every path, cancellation included.
    expect(budget.stats().rangeBody.inUse).toBe(0);
    expect(budget.stats().hostRequests.inUse).toBe(0);
  });

  it('reads normally when Cesium never cancels', async () => {
    // `Resource`'s constructor always assigns
    // `this.request = options.request ?? new Request()` (Core/Resource.js:121),
    // so there is always a request to watch and always a signal — it just
    // never fires. `signalForRequest`'s `undefined` branch is unreachable from
    // here and is covered directly in `tests/cesium-cancellation.test.ts`.
    let seen: AbortSignal | undefined;
    const reader = {
      read: (_range: ByteRange, signal?: AbortSignal) => {
        seen = signal;
        return Promise.resolve({ bytes: new ArrayBuffer(8) } as RangeRead);
      },
      readMany: () => Promise.reject(new Error('not used')),
      stats: () => EMPTY_RANGE_STATS,
    };
    const resource = new ScheduledRangeResource({ url: POINT_URI }, contextWith(reader));
    await resource.fetchArrayBuffer();
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
    expect(budget.stats().rangeBody.inUse).toBe(0);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=~/.local/node22/bin:$PATH npx vitest run tests/cesium-resource.test.ts`
Expected: FAIL — no signal reaches the reader.

- [ ] **Step 3: Thread the signal through**

In `src/cesium-runtime/resource.ts`, in `fetchArrayBuffer`, after the
admission is `admitted`:

```ts
    // Cesium set `this.request` immediately before calling this
    // (`Cesium3DTile.js`, `requestSingleContent`), so this is the object its
    // own `cancelRequests()` cancels. Aborting here is safe: Cesium's catch
    // around the request promise checks `request.cancelled` and puts the tile
    // back rather than failing it.
    const signal = signalForRequest((this as { request?: unknown }).request);
    return ScheduledRangeResource.#readAdmitted(reader, entry, admission.lease, signal);
```

and give `#readAdmitted` the parameter:

```ts
  static async #readAdmitted(
    reader: RangeReader,
    entry: TileEntry,
    lease: Lease,
    signal: AbortSignal | undefined,
  ): Promise<ArrayBuffer> {
    try {
      const { bytes } = await reader.read({ offset: entry.offset, length: entry.length }, signal);
      return bytes;
    } finally {
      lease.release();
    }
  }
```

The `finally` already covers the abort path — an aborted read rejects, and the
lease returns exactly once, as it did for every other ending.

- [ ] **Step 4: Run the tests**

Run: `PATH=~/.local/node22/bin:$PATH npm test && PATH=~/.local/node22/bin:$PATH npm run typecheck`
Expected: green.

- [ ] **Step 5: Mutation-check**

Drop the `signal` argument from the `reader.read(...)` call and re-run
`tests/cesium-resource.test.ts`. Expected: the cancellation test FAILS (the
promise never rejects, so the assertion times out or the `inUse` check runs
against a still-held lease). Restore. Record the outcome — if it passes, the
test is not observing what it claims.

- [ ] **Step 6: Commit**

```bash
git add src/cesium-runtime/resource.ts tests/cesium-resource.test.ts
git commit -m "feat(cesium): abort a Range read when Cesium cancels its tile"
```

---

### Task 4: let a caller abort `fromUrl`

Cesium's cancellation cannot reach the three reads `fromUrl` makes — there is
no tile and no request yet. The caller is the only one who can.

**Files:**
- Modify: `src/cesium-runtime/provider.ts` (`COPCTilesetProviderOptions`, `fromUrl`)
- Test: `tests/cesium-provider.test.ts`

**Interfaces:**
- Produces: `COPCTilesetProviderOptions.signal?: AbortSignal`.

- [ ] **Step 1: Write the failing test**

```ts
  it('lets the caller abort the reads fromUrl makes', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      COPCTilesetProvider.fromUrl(FILE_URL, {
        spawnWorker: createNodeWorkerPort,
        fetch: autzenFetch(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `PATH=~/.local/node22/bin:$PATH npx vitest run tests/cesium-provider.test.ts`
Expected: FAIL — `signal` is not an option, so the call succeeds.

- [ ] **Step 3: Add the option**

In `COPCTilesetProviderOptions`:

```ts
  /**
   * Aborts the three reads `fromUrl` makes before it can return
   * (OVERVIEW §4).
   *
   * Cesium's own cancellation does not reach here — there is no tile and no
   * request yet — so this is the caller's channel, for a component unmounted
   * mid-load. Tile requests are cancelled by Cesium instead
   * (`cancellation.ts`); this signal is not forwarded to them.
   */
  readonly signal?: AbortSignal;
```

and pass it in `fromUrl`: `const file = await openCopc(reader, options.signal);`
(read the current call and keep its surrounding shape).

- [ ] **Step 4: Run the tests**

Run: `PATH=~/.local/node22/bin:$PATH npm test && PATH=~/.local/node22/bin:$PATH npm run typecheck`
Expected: green.

- [ ] **Step 5: Mutation-check**

Remove `options.signal` from the `openCopc` call and re-run. Expected: the new
test FAILS. Restore and record.

- [ ] **Step 6: Commit**

```bash
git add src/cesium-runtime/provider.ts tests/cesium-provider.test.ts
git commit -m "feat(cesium): let a caller abort fromUrl's reads"
```

---

### Task 5: pin the asymmetry that forbids decode cancellation

The reason this plan cancels reads and not decodes is a difference between two
`catch` blocks in one Cesium file. That reason has to be checkable, or the next
person will "finish the job" and start failing tiles.

**Files:**
- Modify: `tests/cesium-contract.test.ts`
- Modify: `docs/superpowers/plans/carried-forward.md`
- Modify: `src/worker/README.md` if it claims anything about cancellation (check first)

- [ ] **Step 1: Write the contract assertions**

Add to `tests/cesium-contract.test.ts`, following the file's `expectSnippet`
style. The source is already loaded there as `tile`:

```ts
  // Why `resource.ts` aborts a Range read: a rejected request whose
  // `cancelled` flag is set puts the tile back rather than failing it.
  it('treats a cancelled request as try-again, not as a failure', () => {
    expectSnippet(
      tile,
      'if (request.cancelled || request.state === RequestState.CANCELLED) { // Cancelled due to low priority - try again later. tile._contentState = previousState;',
    );
  });

  // Why nothing here aborts a decode: the catch around `makeContent` does not
  // consult `cancelled`, so an aborted decode is a terminal FAILED. If this
  // assertion ever fails because Cesium added the check, decode cancellation
  // becomes available and `carried-forward.md` says so.
  it('fails a tile whose content creation throws, cancelled or not', () => {
    const makeContent = tile.indexOf('const content = await makeContent(tile, arrayBuffer);');
    expect(makeContent).toBeGreaterThan(-1);
    const after = tile.slice(makeContent);
    const failed = after.indexOf('tile._contentState = Cesium3DTileContentState.FAILED;');
    expect(failed).toBeGreaterThan(-1);
    // No cancellation check between `makeContent` and the FAILED assignment.
    expect(after.slice(0, failed)).not.toContain('request.cancelled');
  });
```

- [ ] **Step 2: Run them, then mutate the pin**

Run: `PATH=~/.local/node22/bin:$PATH npx vitest run tests/cesium-contract.test.ts`
Expected: PASS.

Then confirm the second assertion can fail: change its search string from
`'request.cancelled'` to `'tileset.statistics'` (which does appear in that
slice) and re-run — expected FAIL. Restore. A contract assertion that cannot
fail pins nothing. Record the outcome.

- [ ] **Step 3: Rewrite the carried-forward entry**

Replace the `No AbortSignal reaches anything src/cesium-runtime/ calls` entry
with one that says what is now true: Range reads and `fromUrl` are cancellable;
decode jobs are not, because Cesium's `makeContent` catch does not check
`request.cancelled` and a cancelled decode would fail the tile terminally;
`tests/cesium-contract.test.ts` pins that asymmetry and will fail when Cesium
changes it. Keep it in the same section.

Delete the hierarchy-budget entry — Task 1 closed it.

- [ ] **Step 4: Run everything**

Run: `PATH=~/.local/node22/bin:$PATH npm test && PATH=~/.local/node22/bin:$PATH npm run typecheck && PATH=~/.local/node22/bin:$PATH npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/cesium-contract.test.ts docs/superpowers/plans/carried-forward.md
git commit -m "test(cesium): pin why a decode cannot be cancelled"
```
