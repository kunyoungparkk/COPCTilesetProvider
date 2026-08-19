# Range Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read several byte ranges in one round trip when they sit close together in the file, prove the saving with numbers rather than assertion, and give callers a way to cancel work they no longer need.

**Architecture:** A pure planner (`src/range/coalesce.ts`) turns a list of ranges into merged spans plus the slice instructions to cut each caller's bytes back out. The reader gains a thin `readMany` that runs the plan through the existing verified `read`, cumulative counters so §7's waste ratio is always observable, and `AbortSignal` plumbing through both entry points and the retry delay.

**Tech Stack:** TypeScript 7 (browser ESM), Vitest, no runtime dependencies.

**Spec:** `OVERVIEW.md` — §3 Decision 4 (coalescing rules and its verification requirement), §3 Decision 5 (every reservation released exactly once, on the cancel path too), §3 Decision 6 (errors are API), §7 (gap threshold, waste cap).

## Global Constraints

- Node 22 for all commands. This machine's default `node` is v18, so every command below assumes `export PATH=/home/kyp/.local/node22/bin:$PATH` first.
- No new runtime dependencies. OVERVIEW §5 fixes the set at `copc`, `laz-perf`, `proj4`; `tests/manifest.test.ts` fails the build if that changes.
- Merging never weakens verification. A merged span is read through the same `read` as any other range, so it still proves an exact 206, a matching `Content-Range`, and the delivered byte count (Decision 4).
- No speculative prefetch. Coalescing only ever spans ranges the caller actually asked for; the gap bytes are collateral, never an excuse to read further.
- `readMany` does not throttle. It receives ranges that admission control already approved, and §7's per-host cap of 6 belongs to the budget module (sub-project 7). A reader that throttled itself would compete with the budget rather than obey it.
- Error messages are public API (Decision 6). Codes may not change; messages name the change that fixes the problem.
- Comments explain *why*, and cite the OVERVIEW decision or §7 row that forced the choice.
- Tests never touch the network — `fetch` is injected — and never sleep on a real timer.
- Commits: `type(scope): summary`, imperative, **under 72 characters**, with a body explaining why. No `Co-Authored-By` or `Signed-off-by` trailers; this repo disables attribution.

## Decisions already settled

These were agreed before this plan was written. Do not relitigate them mid-task; if one turns out to be wrong, stop and report rather than quietly choosing differently.

- **Overlapping or empty input ranges are rejected, not merged.** COPC chunks are disjoint, so an overlap means the descriptor that produced it is wrong. Decision 6 set the precedent with the empty-node invariant: a condition our own structure makes impossible is a bug, and bugs fail loudly with a typed error.
- **Cancellation rejects with the caller's `signal.reason`** — the standard `AbortError` — not a typed error of ours. Typed errors exist to name a change that fixes a problem; a cancellation is a normal outcome with nothing to fix. It also falls out of the retry classifier correctly for free, since it is not a `CopcTilesetError`.
- **Statistics are cumulative counters on the reader**, read through `reader.stats()`. `RangeRead`'s shape does not change.

## File Structure

- `src/range/coalesce.ts` — **new.** The planner: pure arithmetic over `ByteRange[]`, no I/O, no imports from the reader. Every merging rule lives here and is tested without a `fetch` in sight.
- `src/range/range-reader.ts` — gains `readMany`, the counters, and signal plumbing. Verification and retry stay exactly as they are.
- `src/range/content-range.ts` — gains two refusals it already had the doctrine for.
- `src/errors/range.ts` — gains `InvalidByteRangeError`, and a 416 branch on the existing `RangeRequestFailedError`.
- `src/errors/index.ts`, `src/range/index.ts` — re-exports.
- `tests/coalesce.test.ts` — **new.**
- `tests/content-range.test.ts`, `tests/errors.test.ts`, `tests/range-reader.test.ts` — extended.

---

### Task 1: Harden the range primitives

Sub-project 1's review parked three refusals as Minors because nothing could yet produce the bad input. Coalescing computes spans arithmetically, which is exactly where an off-by-one becomes a malformed header, so they land first and everything after builds on them.

**Files:**
- Modify: `src/errors/range.ts`, `src/errors/index.ts`, `src/range/content-range.ts`
- Test: `tests/errors.test.ts`, `tests/content-range.test.ts`

**Interfaces:**
- Consumes: `CopcTilesetError` from `src/errors/base.js`.
- Produces: `InvalidByteRangeError(detail: string)` with code `invalid-byte-range` and a public `detail` field; `formatRangeHeader` now throws it on a non-positive length or negative offset; `parseContentRange` now returns `null` when `end >= totalBytes`; `RangeRequestFailedError` gains a 416-specific message while keeping its `(url, status)` signature and `range-request-failed` code.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/errors.test.ts — add InvalidByteRangeError and
// RangeRequestFailedError to the existing import from '../src/errors/index.js'
describe('InvalidByteRangeError', () => {
  it('blames the caller rather than the server', () => {
    const error = new InvalidByteRangeError('length 0 at offset 375');

    expect(error.code).toBe('invalid-byte-range');
    expect(error.detail).toBe('length 0 at offset 375');
    expect(error.message).toContain('length 0 at offset 375');
    // Decision 4 builds every range from what a previous response reported, so
    // this can only be our own bug — the message has to say so.
    expect(error.message).toContain('bug');
  });
});

describe('RangeRequestFailedError on 416', () => {
  it('names the one cause a range request has for 416', () => {
    const message = new RangeRequestFailedError('https://host/a.copc.laz', 416).message;

    expect(message).toContain('past the end');
    // The generic 4xx advice about credentials would send the reader the wrong way.
    expect(message).not.toContain('credentials');
  });

  it('still gives the generic advice for other 4xx', () => {
    expect(new RangeRequestFailedError('https://host/a.copc.laz', 403).message).toContain(
      'credentials',
    );
  });
});
```

```ts
// append to tests/content-range.test.ts — add formatRangeHeader's new refusals
// and import InvalidByteRangeError from '../src/errors/index.js'
describe('formatRangeHeader refusals', () => {
  // Left unguarded this emits `bytes=0--1`, which a server answers with a
  // confusing 416 rather than the real complaint.
  it('refuses a zero-length range', () => {
    expect(() => formatRangeHeader({ offset: 0, length: 0 })).toThrow(InvalidByteRangeError);
  });

  it('refuses a negative length', () => {
    expect(() => formatRangeHeader({ offset: 10, length: -1 })).toThrow(InvalidByteRangeError);
  });

  it('refuses a negative offset', () => {
    expect(() => formatRangeHeader({ offset: -1, length: 4 })).toThrow(InvalidByteRangeError);
  });
});

describe('parseContentRange bounds', () => {
  // Same doctrine as the `end < start` refusal: totalBytes is handed to callers
  // who do EOF arithmetic with it, so a header that contradicts itself is refused.
  it('refuses a range that ends past the total size', () => {
    expect(parseContentRange('bytes 0-3/2')).toBeNull();
  });

  it('accepts a range ending on the last byte', () => {
    expect(parseContentRange('bytes 0-1/2')?.end).toBe(1);
  });

  it('still accepts an undisclosed total', () => {
    expect(parseContentRange('bytes 0-3/*')?.totalBytes).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/errors.test.ts tests/content-range.test.ts`
Expected: FAIL — `InvalidByteRangeError` is not exported, the 416 message is the generic 4xx one, and both bounds tests pass values the current code accepts.

- [ ] **Step 3: Add the error**

```ts
// append to src/errors/range.ts

/**
 * A byte range that could not have come from a real descriptor.
 *
 * Decision 4 builds every request from an offset and size some earlier response
 * reported, so a zero-length or negative range is not something a server can
 * cause — it is a bug in how the descriptor was constructed. Decision 6 set the
 * precedent with the empty-node invariant: conditions our own structure makes
 * impossible fail loudly rather than being quietly tolerated.
 */
export class InvalidByteRangeError extends CopcTilesetError {
  readonly code = 'invalid-byte-range';
  readonly detail: string;

  constructor(detail: string) {
    super(
      `Invalid byte range: ${detail}. Ranges are derived from offsets and sizes a ` +
        'previous response reported, so this is a bug in how the range was built ' +
        'rather than anything a server did.',
    );
    this.detail = detail;
  }
}
```

Add it to the export list in `src/errors/index.ts`, keeping that list alphabetical.

- [ ] **Step 4: Give 416 its own message**

In `src/errors/range.ts`, replace `RangeRequestFailedError`'s message expression with a three-way choice. Keep the class shape, the code, and the constructor signature exactly as they are.

```ts
    super(
      `${url} returned HTTP ${status}. ` +
        (status >= 500
          ? 'The server reported a temporary failure and the request did not succeed within the configured retry budget.'
          : status === 416
            ? // The one status a range request can provoke by itself: we asked
              // past EOF, which means the file is not what we were told it was.
              'The requested bytes lie past the end of the file, so it has most ' +
              'likely been replaced or truncated since it was opened. Reload the ' +
              'tileset to read the current file.'
            : 'The request was rejected, so resending it would return the same answer. ' +
              'Check the URL, and whether the object requires credentials this library does not send.'),
    );
```

- [ ] **Step 5: Add the two refusals**

In `src/range/content-range.ts`, import the error and guard the formatter:

```ts
import { InvalidByteRangeError } from '../errors/index.js';
```

```ts
/** Builds the `Range` request header for a read. */
export function formatRangeHeader(range: ByteRange): string {
  // A degenerate range emits something like `bytes=0--1`, which a server answers
  // with a 416 that hides the real complaint. A fractional length is worse still
  // once coalescing computes spans arithmetically on top of these numbers.
  const usable =
    Number.isInteger(range.offset) &&
    Number.isInteger(range.length) &&
    range.offset >= 0 &&
    range.length >= 1;
  if (!usable) {
    throw new InvalidByteRangeError(`length ${range.length} at offset ${range.offset}`);
  }

  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}
```

While you are in this file, close a citation gap sub-project 1's review left: the
module comment above `CONTENT_RANGE` explains the refuse-rather-than-guess rule
but never names the decision that requires it, unlike its sibling modules. Add
the reference:

```ts
// Deliberately strict: only `bytes`, only a concrete start and end. Decision 4
// verifies every read against this header, so one we cannot fully understand has
// to be refused — the alternative is handing wrong offsets to a binary parser
// that will read them as corrupt data.
```

And in `parseContentRange`, extend the existing guard:

```ts
  const start = Number(startText);
  const end = Number(endText);
  const totalBytes = totalText === '*' ? null : Number(totalText);
  // Same reason as `end < start`: callers do EOF arithmetic with totalBytes, so
  // a header that contradicts its own total cannot be trusted for that.
  if (end < start || (totalBytes !== null && end >= totalBytes)) {
    return null;
  }

  return { start, end, totalBytes };
```

> `content-range.ts` now imports from `src/errors/`, which it deliberately did not before. That is fine — it still never imports from the reader, so it stays free of I/O and trivially testable.

- [ ] **Step 6: Run the tests and the typechecker**

Run: `npx vitest run && npm run typecheck`
Expected: PASS across all files, `tsc --noEmit` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/errors src/range/content-range.ts tests/errors.test.ts tests/content-range.test.ts
git commit -m "fix(range): refuse ranges and headers that contradict themselves"
```

---

### Task 2: The coalescing planner

**Files:**
- Create: `src/range/coalesce.ts`
- Test: `tests/coalesce.test.ts`

**Interfaces:**
- Consumes: `ByteRange` from `./content-range.js`, `InvalidByteRangeError` from `../errors/index.js`.
- Produces:
  - `interface CoalesceOptions { readonly maxGapBytes?: number; readonly maxWasteRatio?: number }` — defaults `262_144` and `0.02` (§7).
  - `interface CoalescedSlice { readonly index: number; readonly offset: number; readonly length: number }` — `index` is the position in the caller's array, `offset` is relative to the group's span.
  - `interface CoalescedGroup { readonly span: ByteRange; readonly slices: readonly CoalescedSlice[] }`
  - `planCoalescedReads(requests: readonly ByteRange[], options?: CoalesceOptions): readonly CoalescedGroup[]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/coalesce.test.ts
import { describe, expect, it } from 'vitest';
import { InvalidByteRangeError } from '../src/errors/index.js';
import { planCoalescedReads } from '../src/range/coalesce.js';

describe('planCoalescedReads', () => {
  it('returns nothing for no requests', () => {
    expect(planCoalescedReads([])).toEqual([]);
  });

  it('leaves a lone range alone', () => {
    expect(planCoalescedReads([{ offset: 100, length: 50 }])).toEqual([
      { span: { offset: 100, length: 50 }, slices: [{ index: 0, offset: 0, length: 50 }] },
    ]);
  });

  it('merges adjacent ranges into one span with no waste', () => {
    const groups = planCoalescedReads([
      { offset: 0, length: 10 },
      { offset: 10, length: 10 },
    ]);

    expect(groups).toEqual([
      {
        span: { offset: 0, length: 20 },
        slices: [
          { index: 0, offset: 0, length: 10 },
          { index: 1, offset: 10, length: 10 },
        ],
      },
    ]);
  });

  it('merges across a small gap and reports the gap in the span', () => {
    // 8 wasted bytes in a 1000-byte span is 0.8%, inside the 2% cap.
    const groups = planCoalescedReads([
      { offset: 0, length: 500 },
      { offset: 508, length: 492 },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.span).toEqual({ offset: 0, length: 1000 });
    expect(groups[0]?.slices).toEqual([
      { index: 0, offset: 0, length: 500 },
      { index: 1, offset: 508, length: 492 },
    ]);
  });

  it('splits when the gap alone is too wide', () => {
    const groups = planCoalescedReads(
      [
        { offset: 0, length: 1_000_000 },
        { offset: 1_300_000, length: 1_000_000 },
      ],
      { maxGapBytes: 262_144 },
    );

    // The gap is 300 000 bytes — over the threshold — even though it would be
    // a tiny fraction of the merged span. Both conditions must hold (Decision 4).
    expect(groups).toHaveLength(2);
  });

  it('splits when the gap is narrow but wastes too large a share', () => {
    // A 100-byte gap between two 100-byte reads is 33% of the merged span.
    const groups = planCoalescedReads([
      { offset: 0, length: 100 },
      { offset: 200, length: 100 },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.span).toEqual({ offset: 0, length: 100 });
    expect(groups[1]?.span).toEqual({ offset: 200, length: 100 });
  });

  it('closes a group when one more range would push it over the waste cap', () => {
    // Each gap is 1% of the running span on its own, but the third tips the
    // total over 2% — greedy merging has to re-check, not just add.
    const groups = planCoalescedReads(
      [
        { offset: 0, length: 100 },
        { offset: 102, length: 100 },
        { offset: 260, length: 100 },
      ],
      { maxWasteRatio: 0.02 },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.slices.map((s) => s.index)).toEqual([0, 1]);
    expect(groups[1]?.slices.map((s) => s.index)).toEqual([2]);
  });

  it('sorts by offset while keeping each caller index', () => {
    const groups = planCoalescedReads([
      { offset: 10, length: 10 },
      { offset: 0, length: 10 },
    ]);

    expect(groups).toEqual([
      {
        span: { offset: 0, length: 20 },
        slices: [
          { index: 1, offset: 0, length: 10 },
          { index: 0, offset: 10, length: 10 },
        ],
      },
    ]);
  });

  // COPC chunks are disjoint, so these inputs mean the descriptor that produced
  // them is wrong. Merging them quietly would hide the bug.
  it('refuses overlapping ranges', () => {
    expect(() =>
      planCoalescedReads([
        { offset: 0, length: 10 },
        { offset: 5, length: 10 },
      ]),
    ).toThrow(InvalidByteRangeError);
  });

  it('refuses a zero-length range', () => {
    expect(() => planCoalescedReads([{ offset: 0, length: 0 }])).toThrow(InvalidByteRangeError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/coalesce.test.ts`
Expected: FAIL — cannot resolve `../src/range/coalesce.js`.

- [ ] **Step 3: Write the planner**

```ts
// src/range/coalesce.ts
import { InvalidByteRangeError } from '../errors/index.js';
import type { ByteRange } from './content-range.js';

// OVERVIEW §7. A Range request costs a fixed round trip, so merging neighbours
// trades wasted bytes for saved latency — these two numbers say how much waste
// that trade is worth. Changing them requires a measurement against the
// observable Range server and an update to that table.
const DEFAULT_MAX_GAP_BYTES = 256 * 1024;
const DEFAULT_MAX_WASTE_RATIO = 0.02;

export interface CoalesceOptions {
  /** Largest gap between two ranges that may still be read as one. Defaults to 256 KiB. */
  readonly maxGapBytes?: number;
  /** Largest share of a merged span that may be bytes nobody asked for. Defaults to 0.02. */
  readonly maxWasteRatio?: number;
}

/** Where one caller's bytes sit inside the span that was actually read. */
export interface CoalescedSlice {
  /** Position of this range in the caller's original array. */
  readonly index: number;
  /** Offset of these bytes within the group's span, not within the file. */
  readonly offset: number;
  readonly length: number;
}

export interface CoalescedGroup {
  readonly span: ByteRange;
  readonly slices: readonly CoalescedSlice[];
}

/**
 * Groups byte ranges into the fewest spans worth reading.
 *
 * Decision 4 allows a merge only when both conditions hold: the gap between two
 * ranges is within `maxGapBytes`, and the bytes wasted across the whole merged
 * span stay within `maxWasteRatio` of it. The second is re-checked on every
 * addition, because a run of individually-cheap gaps can add up to an expensive
 * span — greedy merging that only looked at the newest gap would never notice.
 *
 * Pure arithmetic: it reads nothing and decides nothing about scheduling.
 */
export function planCoalescedReads(
  requests: readonly ByteRange[],
  options: CoalesceOptions = {},
): readonly CoalescedGroup[] {
  const maxGapBytes = options.maxGapBytes ?? DEFAULT_MAX_GAP_BYTES;
  const maxWasteRatio = options.maxWasteRatio ?? DEFAULT_MAX_WASTE_RATIO;

  const ordered = requests
    .map((range, index) => {
      if (range.length < 1 || range.offset < 0) {
        throw new InvalidByteRangeError(
          `length ${range.length} at offset ${range.offset} (request ${index})`,
        );
      }
      return { index, offset: range.offset, length: range.length };
    })
    .sort((a, b) => a.offset - b.offset);

  const groups: CoalescedGroup[] = [];
  let start = 0;
  let end = 0; // exclusive
  let wanted = 0; // bytes some caller actually asked for
  let slices: CoalescedSlice[] = [];

  const flush = (): void => {
    if (slices.length > 0) {
      groups.push({ span: { offset: start, length: end - start }, slices });
    }
  };

  for (const range of ordered) {
    const rangeEnd = range.offset + range.length;

    if (slices.length === 0) {
      start = range.offset;
      end = rangeEnd;
      wanted = range.length;
      slices = [{ index: range.index, offset: 0, length: range.length }];
      continue;
    }

    if (range.offset < end) {
      // Disjoint chunks are a COPC invariant, so an overlap is a descriptor bug.
      throw new InvalidByteRangeError(
        `request ${range.index} at offset ${range.offset} overlaps the range ending at ${end}`,
      );
    }

    const mergedLength = rangeEnd - start;
    const mergedWaste = mergedLength - (wanted + range.length);
    const gap = range.offset - end;

    // Compared as a product rather than a ratio, so no division rounds a
    // borderline span the wrong way.
    if (gap > maxGapBytes || mergedWaste > mergedLength * maxWasteRatio) {
      flush();
      start = range.offset;
      end = rangeEnd;
      wanted = range.length;
      slices = [{ index: range.index, offset: 0, length: range.length }];
      continue;
    }

    slices.push({ index: range.index, offset: range.offset - start, length: range.length });
    end = rangeEnd;
    wanted += range.length;
  }

  flush();
  return groups;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/coalesce.test.ts && npm run typecheck`
Expected: PASS, `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/range/coalesce.ts tests/coalesce.test.ts
git commit -m "feat(range): plan merged reads for neighbouring ranges"
```

---

### Task 3: readMany

**Files:**
- Modify: `src/range/range-reader.ts`, `src/range/index.ts`
- Test: `tests/range-reader.test.ts`

**Interfaces:**
- Consumes: Task 2's `planCoalescedReads`, `CoalesceOptions`.
- Produces: `RangeReaderOptions` gains `maxGapBytes?: number` and `maxWasteRatio?: number`, forwarded to the planner. `RangeReader` gains `readMany(requests: readonly ByteRange[]): Promise<ArrayBuffer[]>`, returning one buffer per input **in the caller's original order**, regardless of how the ranges were grouped.

> `readMany` returns bare `ArrayBuffer`s rather than `RangeRead`s: `totalBytes` describes the file, not a range, so repeating it once per slice would invite callers to think it varied.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/range-reader.test.ts
describe('readMany', () => {
  it('reads neighbouring ranges in one request and splits the result', async () => {
    // Two 4-byte reads with a 2-byte gap: one 10-byte span.
    const span = new Uint8Array([1, 2, 3, 4, 9, 9, 5, 6, 7, 8]).buffer;
    const { fetch, calls } = stubFetch(partial(span, 'bytes 0-9/1000'));

    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 0, length: 4 },
      { offset: 6, length: 4 },
    ]);

    expect(calls).toEqual([{ url: FILE_URL, range: 'bytes=0-9' }]);
    expect(new Uint8Array(results[0]!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(results[1]!)).toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  it('returns buffers in the caller order even when the file order differs', async () => {
    const span = new Uint8Array([1, 2, 3, 4]).buffer;
    const { fetch } = stubFetch(partial(span, 'bytes 0-3/1000'));

    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 2, length: 2 },
      { offset: 0, length: 2 },
    ]);

    expect(new Uint8Array(results[0]!)).toEqual(new Uint8Array([3, 4]));
    expect(new Uint8Array(results[1]!)).toEqual(new Uint8Array([1, 2]));
  });

  it('issues one request per group when ranges are too far apart', async () => {
    const { fetch, calls } = stubFetch(
      partial(new Uint8Array([1, 2]).buffer, 'bytes 0-1/9000000'),
      partial(new Uint8Array([3, 4]).buffer, 'bytes 8000000-8000001/9000000'),
    );

    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 0, length: 2 },
      { offset: 8_000_000, length: 2 },
    ]);

    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
  });

  it('reads nothing for an empty request list', async () => {
    const { fetch, calls } = stubFetch();

    expect(await createRangeReader(FILE_URL, { fetch }).readMany([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  // A merged span is verified exactly like any other read (Decision 4).
  it('rejects a merged span whose Content-Range does not match', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(10), 'bytes 0-8/1000'));

    await expect(
      createRangeReader(FILE_URL, { fetch, retryDelaysMs: [] }).readMany([
        { offset: 0, length: 4 },
        { offset: 6, length: 4 },
      ]),
    ).rejects.toMatchObject({ code: 'content-range-mismatch' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/range-reader.test.ts -t readMany`
Expected: FAIL — `readMany is not a function`.

- [ ] **Step 3: Add readMany**

In `src/range/range-reader.ts`, import the planner and extend the options and the interface:

```ts
import { planCoalescedReads } from './coalesce.js';
```

```ts
  /** Largest gap between two ranges that may still be read as one. Defaults to 256 KiB (§7). */
  readonly maxGapBytes?: number;
  /** Largest share of a merged span that may be bytes nobody asked for. Defaults to 0.02 (§7). */
  readonly maxWasteRatio?: number;
```

```ts
export interface RangeReader {
  read(range: ByteRange): Promise<RangeRead>;
  /**
   * Reads several ranges, merging neighbours into shared requests.
   *
   * Returns one buffer per request, in the caller's order, whatever grouping
   * the planner chose.
   */
  readMany(requests: readonly ByteRange[]): Promise<ArrayBuffer[]>;
}
```

Inside `createRangeReader`, after the existing option reads:

```ts
  const coalesceOptions = {
    ...(options.maxGapBytes !== undefined && { maxGapBytes: options.maxGapBytes }),
    ...(options.maxWasteRatio !== undefined && { maxWasteRatio: options.maxWasteRatio }),
  };
```

> Spread-on-condition rather than passing `undefined` through: `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the same as an absent property and would not fall back to the planner's default.

Then, beside `read`:

```ts
  async function readMany(requests: readonly ByteRange[]): Promise<ArrayBuffer[]> {
    const groups = planCoalescedReads(requests, coalesceOptions);
    const results: ArrayBuffer[] = new Array<ArrayBuffer>(requests.length);

    // Groups run concurrently on purpose. Coalescing exists to remove round
    // trips, and serialising what is left would give the latency back. Bounding
    // how many run at once is admission control's job (Decision 5), and this
    // reader only ever sees ranges the budget already approved.
    await Promise.all(
      groups.map(async (group) => {
        const { bytes } = await read(group.span);
        for (const slice of group.slices) {
          results[slice.index] = bytes.slice(slice.offset, slice.offset + slice.length);
        }
      }),
    );

    return results;
  }

  return { read, readMany };
```

Re-export the planner's types from `src/range/index.ts`:

```ts
export type { CoalesceOptions, CoalescedGroup, CoalescedSlice } from './coalesce.js';
export { planCoalescedReads } from './coalesce.js';
```

- [ ] **Step 4: Make the fetch stub fail loudly when it runs dry**

Every assertion in this task turns on how many requests were issued, so the
test double has to be trustworthy about that. Today `stubFetch` throws
synchronously when its queue empties, and that throw lands inside `readOnce`'s
fetch `try` — where it becomes a `RangeNetworkError`, which is *retryable*, so
an under-supplied stub quietly loops instead of failing. Record the overrun
instead of only throwing:

```ts
function stubFetch(...responses: Response[]) {
  const calls: { url: string; range: string | null }[] = [];
  const queue = [...responses];
  const overruns = { count: 0 };

  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), range: headers.get('range') });

    const next = queue.shift();
    if (next === undefined) {
      // Throwing here is not enough on its own: the reader turns it into a
      // retryable network error, so the shortfall would hide as a retry.
      overruns.count += 1;
      throw new Error('stub fetch ran out of responses');
    }
    return Promise.resolve(next);
  };

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, overruns };
}
```

Then assert `overruns.count` is `0` in the three `readMany` tests above that
count calls. Leave the existing tests alone — they already pin their call counts
directly.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/range tests/range-reader.test.ts
git commit -m "feat(range): read merged spans and split them per caller"
```

---

### Task 4: Cumulative statistics

**Files:**
- Modify: `src/range/range-reader.ts`, `src/range/index.ts`
- Test: `tests/range-reader.test.ts`

**Interfaces:**
- Produces: `interface RangeStats { readonly requests: number; readonly retries: number; readonly bytesRequested: number; readonly bytesWasted: number; readonly requestsSaved: number }` and `RangeReader.stats(): RangeStats`, a frozen snapshot of counters accumulated since the reader was created.

> §7 requires the real waste ratio to be observable at all times. These counters are what it is computed from — `bytesWasted / bytesRequested` — rather than a stored ratio, so there is one source of truth and no field that can go stale.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/range-reader.test.ts
describe('stats', () => {
  it('starts at zero', () => {
    const { fetch } = stubFetch();

    expect(createRangeReader(FILE_URL, { fetch }).stats()).toEqual({
      requests: 0,
      retries: 0,
      bytesRequested: 0,
      bytesWasted: 0,
      requestsSaved: 0,
    });
  });

  it('counts a plain read with no waste', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), 'bytes 0-3/1000'));
    const reader = createRangeReader(FILE_URL, { fetch });

    await reader.read({ offset: 0, length: 4 });

    expect(reader.stats()).toMatchObject({
      requests: 1,
      bytesRequested: 4,
      bytesWasted: 0,
      requestsSaved: 0,
    });
  });

  it('records the gap bytes a merge paid for and the round trip it saved', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(10), 'bytes 0-9/1000'));
    const reader = createRangeReader(FILE_URL, { fetch });

    await reader.readMany([
      { offset: 0, length: 4 },
      { offset: 6, length: 4 },
    ]);

    const stats = reader.stats();
    expect(stats.requests).toBe(1);
    expect(stats.bytesRequested).toBe(10);
    expect(stats.bytesWasted).toBe(2);
    expect(stats.requestsSaved).toBe(1);
    // The §7 figure the knobs are tuned against.
    expect(stats.bytesWasted / stats.bytesRequested).toBeCloseTo(0.2);
  });

  it('counts a retried request twice and records the retry', async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = stubFetch(
        new Response(null, { status: 503 }),
        partial(new ArrayBuffer(2), 'bytes 0-1/500'),
      );
      const reader = createRangeReader(FILE_URL, { fetch });

      const pending = reader.read({ offset: 0, length: 2 });
      await vi.advanceTimersByTimeAsync(500);
      await pending;

      expect(reader.stats()).toMatchObject({ requests: 2, retries: 1, bytesRequested: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands out a snapshot the caller cannot mutate', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), 'bytes 0-3/1000'));
    const reader = createRangeReader(FILE_URL, { fetch });
    const before = reader.stats();

    await reader.read({ offset: 0, length: 4 });

    expect(before.requests).toBe(0);
    expect(reader.stats().requests).toBe(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/range-reader.test.ts -t stats`
Expected: FAIL — `stats is not a function`.

- [ ] **Step 3: Add the counters**

In `src/range/range-reader.ts`:

```ts
export interface RangeStats {
  /** HTTP requests issued, counting each retry separately. */
  readonly requests: number;
  readonly retries: number;
  /** Bytes asked for across those requests, gap bytes included. */
  readonly bytesRequested: number;
  /** Of those, bytes no caller wanted — the price merging paid. */
  readonly bytesWasted: number;
  /** Round trips merging removed. */
  readonly requestsSaved: number;
}
```

Add `stats(): RangeStats;` to `RangeReader`.

Inside `createRangeReader`, before `deadlineFor`:

```ts
  // §7 tunes the merge thresholds against measured request counts and waste, so
  // those figures have to be observable at all times rather than inferred.
  const counters = {
    requests: 0,
    retries: 0,
    bytesRequested: 0,
    bytesWasted: 0,
    requestsSaved: 0,
  };
```

At the top of `readOnce`, right after `const requested = formatRangeHeader(range);`:

```ts
    counters.requests += 1;
    counters.bytesRequested += range.length;
```

In `read`, immediately before `await sleep(delayMs);`:

```ts
        counters.retries += 1;
```

In `readMany`, right after the plan is computed:

```ts
    for (const group of groups) {
      counters.bytesWasted +=
        group.span.length - group.slices.reduce((total, slice) => total + slice.length, 0);
      counters.requestsSaved += group.slices.length - 1;
    }
```

And the accessor, beside `readMany`:

```ts
  function stats(): RangeStats {
    // A copy, so a caller holding an old snapshot sees the numbers as they were.
    return { ...counters };
  }

  return { read, readMany, stats };
```

Export the type from `src/range/index.ts`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/range tests/range-reader.test.ts
git commit -m "feat(range): expose the request and waste counters"
```

---

### Task 5: Cancellation

**Files:**
- Modify: `src/range/range-reader.ts`
- Test: `tests/range-reader.test.ts`

**Interfaces:**
- Produces: `read(range: ByteRange, signal?: AbortSignal)` and `readMany(requests: readonly ByteRange[], signal?: AbortSignal)`. An aborted call rejects with `signal.reason` — the caller's own `AbortError` — not with a typed error of ours.

> Two things make this more than plumbing. First, an external abort also trips the reader's internal `AbortController`, so without care a cancelled request is reported as `RangeTimeoutError` — a lie about why it stopped. The catch has to ask about the caller's signal first. Second, the retry delay must be interruptible, or a cancel issued during a 2-second wait is ignored until it expires.
>
> Decision 5 requires every reservation to be released exactly once on the cancel path too, which is only possible if cancelling actually settles the promise.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/range-reader.test.ts
describe('cancellation', () => {
  it('does not send a request that was cancelled before it started', async () => {
    const { fetch, calls } = stubFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  // The bug this guards: the caller's abort also trips the internal deadline
  // controller, so a cancelled read would otherwise be blamed on a timeout.
  it('reports a cancellation as an abort, not as a timeout', async () => {
    const controller = new AbortController();
    const fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof globalThis.fetch;

    const pending = createRangeReader(FILE_URL, { fetch }).read(
      { offset: 0, length: 4 },
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
  });

  it('cuts a retry delay short instead of waiting it out', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { fetch, calls } = stubFetch(
        new Response(null, { status: 503 }),
        partial(new ArrayBuffer(2), 'bytes 0-1/500'),
      );

      const pending = createRangeReader(FILE_URL, { fetch }).read(
        { offset: 0, length: 2 },
        controller.signal,
      );
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      // Far short of the 500 ms delay: the abort, not the clock, ends the wait.
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await assertion;

      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels every group of a readMany', async () => {
    const controller = new AbortController();
    const fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof globalThis.fetch;

    const pending = createRangeReader(FILE_URL, { fetch }).readMany(
      [
        { offset: 0, length: 2 },
        { offset: 8_000_000, length: 2 },
      ],
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
  });

  it('still works with no signal at all', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), 'bytes 0-3/1000'));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).resolves.toMatchObject({ totalBytes: 1000 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/range-reader.test.ts -t cancellation`
Expected: FAIL — the signal is ignored, so the pre-cancelled read still issues a request and the mid-flight abort surfaces as `range-timeout`.

- [ ] **Step 3: Make the delay interruptible**

Replace the `sleep` constant in `src/range/range-reader.ts`:

```ts
/** A delay a caller's abort can cut short, so a cancel is not stalled by a retry wait. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 4: Thread the signal through**

Give `readOnce` a second parameter and link the signals:

```ts
  async function readOnce(range: ByteRange, signal?: AbortSignal): Promise<RangeRead> {
    signal?.throwIfAborted();

    const requested = formatRangeHeader(range);
    counters.requests += 1;
    counters.bytesRequested += range.length;

    const timeoutMs = deadlineFor(range);
    const controller = new AbortController();
    // ...existing comment about the hand-rolled timer...
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
```

In the `catch`, ask about the caller's signal before anything else:

```ts
    } catch (cause) {
      // The caller's abort also trips our deadline controller, so this has to
      // come first — otherwise a cancelled read is reported as a timeout.
      signal?.throwIfAborted();
      if (cause instanceof CopcTilesetError) {
        throw cause;
      }
      throw controller.signal.aborted
        ? new RangeTimeoutError(url, timeoutMs)
        : new RangeNetworkError(url, cause);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
```

> `throwIfAborted` is the platform's own accessor for exactly this: it throws `signal.reason` when aborted and does nothing otherwise. Note that the pre-flight check happens **before** the request counter increments, so a cancelled-before-start read is not counted as a request that never happened.

Then pass the signal down through `read` and `readMany`:

```ts
  async function read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readOnce(range, signal);
      } catch (error) {
        const delayMs = retryDelaysMs[attempt];
        if (delayMs === undefined || !isWorthRetrying(error)) {
          throw error;
        }
        counters.retries += 1;
        await sleep(delayMs, signal);
      }
    }
  }
```

```ts
  async function readMany(
    requests: readonly ByteRange[],
    signal?: AbortSignal,
  ): Promise<ArrayBuffer[]> {
```

and inside it, `await read(group.span, signal)`.

Update the two signatures on the `RangeReader` interface to match.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, and the run's wall clock stays near a second — a cancellation test that waits out a real delay means the signal is not reaching `sleep`.

- [ ] **Step 6: Commit**

```bash
git add src/range tests/range-reader.test.ts
git commit -m "feat(range): let callers cancel reads and retry waits"
```

---

## Self-review before handing off

- [ ] Every §7 row this plan touches — gap 256 KiB, waste 2% — appears as a named constant with the section cited, not an inlined number.
- [ ] `planCoalescedReads` is still free of I/O and imports nothing from the reader.
- [ ] No task added throttling, prefetching, or a second verification path.

## Done when

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` passes, including the four suites that existed before this plan.
- [ ] The suite's wall clock is still near one second — no test sleeps on a real timer.
- [ ] `src/range/README.md` describes coalescing, which it already claims; check it still reads true and leave it alone if so.
- [ ] No new entry in `package.json` `dependencies`.
