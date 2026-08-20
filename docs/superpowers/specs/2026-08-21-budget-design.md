# Resource budget and leases — design

**Goal.** Decide whether work may start, and guarantee that whatever is reserved
comes back exactly once.

**Spec.** `OVERVIEW.md` — §3 Decision 5 (the three budgets, the three-way
verdict, the exactly-once rule), Decision 1 (no request queue of our own), §4
(where admission sits in the frame), §6 (an accurate global *point* budget is
out of scope), §7 (the values).

## What this is, and what it refuses to be

A synchronous state machine. `acquire` answers immediately and holds nothing —
no promise, no timer, no queue. A caller told `deferred` simply does not start;
Cesium's traversal asks again next frame, which is §4's `다음 프레임 재시도` and
the only reading compatible with Decision 1's ban on our own request queue.

Two consequences worth stating up front. Nothing here needs a frame abstraction,
so no test fakes one. And the module cannot starve a caller by forgetting it,
because it never remembers one.

§6 puts an accurate global *point* budget out of scope. That is a statement
about points as a resource, not about admission control: bytes in flight,
concurrent decode jobs, and retained hierarchy pages are all still bounded here.

## The four things bounded

| budget | unit | §7 initial | scope |
|---|---|---|---|
| Range body | bytes in flight | 32 MB | per provider |
| decode | concurrent jobs | 8 (pool × 2) | per provider |
| hierarchy | retained parsed pages | 64 | per provider |
| host requests | concurrent requests | 6 | **per origin, process-wide** |

The first three belong to a provider because a provider is what gets destroyed
and what owns the memory: two datasets on one globe genuinely do cost twice.

The fourth does not. §7's cap of 6 is the browser's connection ceiling for a
host, which two providers reading the same bucket really do share — so it lives
in a process-wide table keyed by origin, and a provider's `destroy` releases the
slots that provider still holds.

§7's hierarchy row says `페이지 캐시 64개`. It is modelled as a lease on a
*retained parsed page* — acquired when a page is kept, released when it is
dropped — so that all four bounds have the same acquire/release shape and
Decision 5's exactly-once rule means one thing everywhere rather than three.

## Interface

```ts
export type Admission =
  | { readonly verdict: 'admitted'; readonly lease: Lease }
  | { readonly verdict: 'deferred' }
  | { readonly verdict: 'rejected'; readonly reason: RejectionReason };

/** Not idempotent on purpose: a second `release` is a bug, and says so. */
export interface Lease {
  release(): void;
}

export type RejectionReason = 'over-capacity' | 'destroyed';

export interface Budget {
  /**
   * A Range request needs two things at once — room in the byte budget and a
   * slot on its host — so it asks for both in one call and gets one lease that
   * returns both.
   */
  acquireRangeRequest(origin: string, bytes: number): Admission;
  acquireDecodeJob(): Admission;
  acquireHierarchyPage(): Admission;
  stats(): BudgetStats;
  destroy(): void;
}

export function createBudget(limits?: Partial<BudgetLimits>): Budget;
```

`BudgetLimits` is the four values in the table above; `BudgetStats` is described
under Statistics.

**Composite acquisition is atomic.** `acquireRangeRequest` takes bytes and a
host slot together, and if either is unavailable neither is taken. A two-call
version would have a state where the first is held and the second is refused,
and the caller would have to unwind it correctly on every path — which is
precisely the bug Decision 5 exists to make impossible.

## The verdicts

- **admitted** — every part was reserved. The lease returns all of them.
- **deferred** — not now, but a later frame could say yes. Nothing is reserved
  and nothing is remembered.
- **rejected** — asking again cannot help. Exactly two causes: the request is
  larger than the budget's whole capacity, so no amount of waiting frees enough
  (`over-capacity`), or the budget has been destroyed (`destroyed`).

No deadline, no deferral counter, no back-off. Those would be policy, and §7
would have to carry their values; the line above needs no value at all.

## Exactly once

The rule is Decision 5's, and it is the module's only hard invariant:

> 모든 예약은 성공·실패·취소·destroy 어느 경로로 끝나든 한 번만 반환.

- Every `admitted` verdict yields exactly one `Lease`.
- `release()` returns everything that lease took, once.
- **A second `release()` throws `LeaseAlreadyReleasedError`.** Following the
  `InvalidByteRangeError` precedent (`src/errors/range.ts`), a condition our own
  structure makes impossible fails loudly rather than silently. "Exactly once"
  is only enforceable if the second call is observable; a no-op would let a
  double-release hide until the counters drifted far enough to notice.
- **`destroy()` adopts outstanding leases.** It marks the budget destroyed so
  further acquisitions are `rejected`, releases everything still held — including
  this provider's host slots — and accepts a later `release()` from an adopted
  lease as its one release. The holder did nothing wrong and must not be
  punished for a lifetime it does not control. A *second* release still throws.

## Prerequisite: a transport bug that makes the invariant unachievable

`readMany` runs its coalesced groups under `Promise.all` with no controller
linking them (`src/range/range-reader.ts:326-341`). When one group fails
fatally, the caller's promise rejects and the siblings keep going. Measured: a
sibling answered 503 ran its full §7 retry ladder — two further requests over
2.5 s — *after* the caller had already been given the error, and incremented the
reader's cumulative counters while doing it.

That defect was never recorded in a plan or in `carried-forward.md`; the only
trace in the repo is a parenthetical in a test comment for the cancellation case
(`tests/range-reader.test.ts:618-621`).

It has to be fixed before a lease can be held around a `readMany`, because work
that outlives the call has no moment at which its lease could be returned. The
fix is a linked `AbortController` inside `readMany`: a fatal group failure
aborts its siblings, the caller still sees the original error, and the siblings
end silently. It belongs in the transport rather than in a wrapper, because
sibling requests are created inside `readMany` and are not reachable from
outside it.

Requests that were actually issued keep counting in `stats()`, orphaned or not —
the counters' contract is that they match what a server would log, and the server
did see them.

## Statistics

`stats()` returns, per budget: `admitted`, `deferred`, `rejected`, `inUse`, and
`peak`. `peak` is what §7 is retuned against — three of its five values call
themselves `임의 시작점`, and a high-water mark is the measurement that replaces
a guess.

## Verification

The invariant is a counting property, so the tests are counting tests.

- **Every exit path returns exactly once**, enumerated: success, failure,
  cancellation, destroy — Decision 5 names four, so four tests, each asserting
  `inUse` is back to zero and that a further `release()` throws.
- **Atomicity**: when the host cap is full but bytes are free, a refused
  `acquireRangeRequest` leaves the byte budget untouched. This is the test that
  a two-call design would need and could not pass.
- **Rejection is only ever the two causes.** A request that is merely too big
  *for now* is `deferred`; one bigger than capacity is `rejected`. The pair is
  asserted together, because the interesting failure is a boundary that puts a
  recoverable request in the permanent bucket.
- **`destroy` with leases outstanding**: the adopted lease's later release is
  accepted, a second throws, and nothing double-counts.
- **The transport fix** gets its own test in `tests/range-reader.test.ts`,
  written the way the existing cancellation test is: compare what started
  against what aborted, and assert `vi.getTimerCount()` is zero so no retry
  ladder is left scheduled.

No test uses real time; fake timers follow the existing `try`/`finally` idiom
rather than `beforeEach`. The budget itself has no timers to fake.

## Decisions settled — do not relitigate mid-task

- **Synchronous verdicts, nothing held, no queue.** Decision 1.
- **Three per-provider budgets; the host cap is per origin and process-wide.**
- **Hierarchy is a lease on a retained page**, not a cache with eviction.
- **Range reservations are denominated in the bytes the caller asked for**, plus
  §7's waste allowance. The merged span is planned inside `readMany` and is not
  visible to an admission that must happen first (§4's order); §7 bounds the
  error at 2 %, so it is wrong in a known direction by a known amount.
- **A double release throws.**
- **Limits are constructor options, not public API.** §7 marks only
  `maximumScreenSpaceError` public. Exposing any of these is a separate ask.
