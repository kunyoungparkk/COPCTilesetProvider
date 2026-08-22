# Worker pool and message protocol — design

**Goal.** Run the PNTS pipeline off the main thread: a pool of Workers, a
message protocol both realms agree on, and an admission rule that keeps a
camera sweep from queueing work nobody still wants.

**Spec.** `OVERVIEW.md` — §3 Decision 3 (heavy work in a Worker; only
compressed input and encoded output move as Transferables), Decision 5
(budgets and leases, admitted/deferred/rejected, exactly-once release),
Decision 6 (errors are part of the API), §5 (dependency list, Rollup Worker
bundle), §7 (Worker pool size 4, decode budget = pool size × 2).

## Scope

This is the second half of the Worker sub-project. The first half shipped as
`src/worker/{decode,positions,pnts,pipeline}.ts`: pure functions, compressed
bytes in, PNTS bytes out, with `encodeNode` as their composition.

**In scope:** the pool, the protocol, transferable handoff, cancellation,
error transport across the realm boundary, and the budget integration that
decides what gets admitted.

**Out of scope, deliberately:**

- **Bundling.** OVERVIEW §5 calls for a Rollup self-contained Worker bundle
  including the laz-perf WASM. That tooling does not exist — `package.json`
  declares `typecheck`, `test` and `test:watch` and nothing else, and the
  manifest deliberately does not advertise a script that cannot run. The pool
  therefore never constructs a platform `Worker`; it takes a port factory.
  Bundling, and the browser adapter that uses it, are their own sub-project.
- **The caller.** `src/cesium-runtime/` is a README and nothing else. The
  pool's surface is designed against the codec contract Decision 2 describes,
  but no code calls it yet. See *Risks* below — this is the one place this
  design can be wrong in a way its own tests cannot catch.

## What was measured before designing

Everything below rests on one probe, run on this machine, and it is worth
re-running before implementation rather than trusting this paragraph.

A real `node:worker_threads` Worker imported `src/worker/index.ts` directly,
received a transferred `ArrayBuffer` holding the pinned 951-byte chunk, ran
laz-perf's WASM decode and proj4 through `encodeNode`, and posted back a PNTS
buffer:

```
reply: {"ok":true,"byteLength":2024}
magic: pnts
sender buffer after transfer: 0 (0 = neutered)
```

Three facts come out of that, and each one shapes a section below.

1. **2024 bytes and the magic `pnts`** match what `tests/worker-pnts.test.ts`
   measures for the same chunk on the main thread. The pipeline behaves the
   same in a Worker realm; nothing about it was secretly main-thread-bound.
2. **The sender's buffer reports `byteLength` 0 after the post**, so
   Transferables genuinely move rather than copy. Decision 3's "only
   compressed input and PNTS output move" is testable, not aspirational.
3. **Node 22.20 runs the repository's TypeScript in a Worker without a build
   step** — but only with help. Native type stripping does not rewrite a
   `.js` specifier to `.ts`, and every file under `src/` uses `.js`
   specifiers, so a bare `node` fails with `ERR_MODULE_NOT_FOUND` on
   `src/worker/pipeline.js`. A ~15-line `node:module` resolve hook that falls
   back from `.js` to a sibling `.ts` closes it, passed to the Worker as
   `execArgv: ['--import', hook]`. No new dependency.

   That this works at all is not luck: `tsconfig.json` already sets
   `erasableSyntaxOnly`, which exists precisely to keep a codebase
   type-strippable. `src/` is structurally safe for this by construction.

The consequence is the important one: **the tests can drive a real Worker.**
A fake port would prove the pool's bookkeeping and nothing about structured
clone, transferable neutering, or WASM in a second realm — which is exactly
where the risk lives.

## The realm split

`src/worker/` now holds code for two realms, so it copies what `src/crs/`
already does rather than inventing a second convention.

| File | Realm | Responsibility |
|---|---|---|
| `src/worker/entry.ts` | Worker | Receives messages, calls `encodeNode`, posts results. The file the bundler will later make self-contained. |
| `src/worker/pool.ts` | Main | Owns the port set, the budget, the task table, cancellation. Never constructs a platform `Worker`. |
| `src/worker/protocol.ts` | Both | The message shapes and the wire error form. The only file both realms import. |
| `src/worker/index.ts` | Worker | Unchanged: the pipeline barrel `entry.ts` imports. |

`tests/worker-boundary.test.ts` gains two assertions, both in the direction
that can fail silently:

- `entry.ts`'s transitive import closure does **not** contain
  `crs/registry.ts`, `crs/resolve.ts` or `crs/index.ts` — the same rule
  `pipeline.ts` already carries, now asserted at the file that actually runs
  in the Worker.
- `entry.ts`'s closure does **not** contain `worker/pool.ts`. A Worker that
  pulled the pool in would bundle the main thread's half of the system into
  every Worker, and nothing else would notice.

Both assertions sit beside the existing positive one, so neither can pass
vacuously (`tests/import-closure.ts` refuses a closure it cannot resolve).

## The protocol

Two messages out, three in. Every message carries an `id`; ids are opaque to
the Worker.

**Main → Worker**

```ts
type ToWorker =
  | { kind: 'init'; id: number; definition: string }
  | { kind: 'encode'; id: number; compressed: ArrayBuffer; header: DecodeHeader; pointCount: number };
```

**Worker → main**

```ts
type FromWorker =
  | { kind: 'ready'; id: number }
  | { kind: 'done'; id: number; pnts: ArrayBuffer }
  | { kind: 'failed'; id: number; error: WireError };
```

`compressed` and `pnts` are the only Transferables, in that order — Decision
3's rule, stated as a type rather than a comment.

### Why `init` is a separate message

`encodeNode` takes the resolved proj4 definition per call and builds its own
transform, measured at 50.6 µs per chunk. A 50k-point node costs about 144 ms
across the three stages (§7's row: 0.90 + 1.77 + 0.21 µs/point), so building
the transform again for every chunk is roughly 0.035% of that node's worker
time. This design does **not** change that and does not add a "build the
transform once" optimisation: §7 takes changes from measurement in a fixed
environment, and nobody has measured a pool.

`init` exists for two other reasons:

- The definition crosses **once per Worker** rather than once per tile. It is
  a string, so this is not about bytes; it is about there being one place
  where a Worker's CRS is established and one place where establishing it can
  fail.
- A Worker that cannot build a transform never receives work. `ready` is the
  Worker saying it built one successfully; until it arrives, the pool holds
  that Worker out of rotation.

`init`'s reply is `ready` or `failed`. A `failed` init is not retried against
the same port — see *Worker failure*.

### Why there is no cancel message

Cancellation is entirely main-thread bookkeeping, and the protocol says so by
having no `cancel` message at all.

- A task that has **not been posted** cannot be cancelled remotely because the
  Worker has never heard of it. The pool drops it from its own table.
- A task that **has been posted** is inside a synchronous laz-perf WASM call
  that owns the Worker's event loop. A `cancel` message would sit unread in
  the queue until the decode it was meant to stop had already finished. It
  would be a message that cannot do its job by construction.

So a cancelled in-flight task is *abandoned*: the pool marks the id dead, and
when `done` or `failed` eventually arrives it is discarded — after the lease
is released. This is the honest description of what the platform allows, and
writing it into the protocol keeps a future reader from adding a `cancel`
message that appears to work.

The alternative considered and rejected: `terminate()` the Worker to reclaim
the CPU immediately. It pays a WASM re-initialisation cost and kills whatever
*other* task that Worker had already been given, so it trades a wasted decode
for a wasted decode plus a restart.

## Admission: the budget is the queue

The pool has **no unbounded queue**. `encode()` returns the same three-way
verdict Decision 5 defines, and the caller — Cesium's per-frame traversal —
is what retries.

```ts
type EncodeVerdict =
  | { verdict: 'admitted'; pnts: Promise<ArrayBuffer> }
  | { verdict: 'deferred' }
  | { verdict: 'rejected'; reason: RejectionReason };
```

The field is `verdict` and `RejectionReason` is the budget's own
(`'over-capacity' | 'destroyed'`), because this verdict *is* the budget's
verdict with a promise attached. A second vocabulary for the same three
outcomes would make every call site translate between them.

- **admitted** — a decode lease was granted. If a port is idle the task is
  posted now; otherwise it waits, holding its lease.
- **deferred** — the decode budget is full. Nothing is queued and nothing is
  remembered. The caller asks again next frame, which is the rhythm Cesium
  already runs on.
- **rejected** — a permanent refusal, carrying the typed error.

With §7's values (pool size 4, decode budget 8) at most 8 tasks are alive and
at most 4 are running, so at most 4 wait. The waiting set's bound *is* the
budget; there is no second number to keep in sync.

This is the first place Decision 5's three-way verdict is used by a real
caller, and it is what makes §7's decode row mean something. An unbounded
queue would leave that row describing only how many tasks run at once, while
a single camera sweep piled thousands of dead tiles behind them.

### Lease discipline

Every lease is released exactly once, on every path: `done`, `failed`,
cancellation before posting, abandonment after posting, a Worker crash, and
`destroy()`. This is Decision 5's requirement and it is the pool's single
most testable property — see *Verification*.

## Errors across the boundary

Structured clone erases class identity: a `ZeroPointChunkError` thrown in a
Worker arrives on the main thread as a plain object with no prototype and no
`code`. Decision 6 makes errors part of the API, so the boundary has to put
them back together.

```ts
interface WireError { code: string | null; name: string; message: string }
```

`toWire(error)` runs in the Worker; `fromWire(wire)` runs on the main thread
and rebuilds the original class from a `code → constructor` map, so both
`instanceof` and `.code` mean the same thing on both sides of the boundary.

An error that is not one of ours — laz-perf throwing, a V8 `RangeError` from
an allocation — has `code: null` and is rebuilt as a `WorkerTaskFailedError`
carrying the original `name` and `message` as its `cause`. It is typed, so a
caller can still branch on it, and it does not pretend to be something it is
not.

**The map is the drift risk**, and it is this repository's most familiar
failure shape: a new error class gets added, nobody updates the map, and it
silently degrades to the generic case. The guard is a source-scanning test —
the same shape as the `src/` tree scan `tests/import-closure.test.ts`
already uses — that reads every `readonly code = '...'` declaration under
`src/errors/` and asserts the map's key set equals it exactly. Adding an
error without touching the map turns that test red.

## The port

The pool never touches a platform Worker API. It takes a factory for a port
it defines itself:

```ts
interface WorkerPort {
  post(message: ToWorker, transfer: readonly ArrayBuffer[]): void;
  onMessage(handler: (message: FromWorker) => void): void;
  onError(handler: (error: Error) => void): void;
  terminate(): void;
}
```

Browser `Worker` and `node:worker_threads.Worker` are not structurally
compatible — `addEventListener` versus `on` — so one of them would need an
adapter regardless. Defining the port makes both adapters thin, keeps the DOM
`Transferable` type out of a library that must typecheck under `@types/node`,
and states the whole platform surface this system needs in six lines.

`ArrayBuffer[]` rather than `Transferable[]`: buffers are the only thing this
protocol ever transfers, and the narrower type says so.

### Pool options

```ts
interface WorkerPoolOptions {
  spawn: () => WorkerPort;
  definition: string;
  budget: Budget;
  size?: number;   // §7: 4
}
```

The pool does **not** create a budget. `Budget` is provider-scoped and already
tracks four resources together; the pool calls `acquireDecodeJob()` on the one
its provider owns, and the limit comes from that provider's
`BudgetLimits.decodeJobs` (§7: pool size × 2). Giving the pool its own
concurrency number would put the same value in two places, and §7 would only
govern one of them.

Ports are spawned **lazily**, up to `size`, as work arrives. A file whose
tiles all fit in one Worker never pays to start four, and `fromUrl` does not
spend WASM initialisation on Workers the camera may never need.

## Worker failure

A port's `onError`, or a `failed` reply to `init`, means that Worker is not
usable.

- Its in-flight task fails with `WorkerTaskFailedError` and its lease is
  released.
- The port is terminated and dropped from the set. The next task that needs a
  port spawns a fresh one through the same factory, so a transient crash
  costs one task rather than the pool.
- If `spawn` itself throws, the pending task is rejected with that error
  rather than retried — a factory that cannot make a Worker will not start
  working on the next call, and retrying would hide the reason.

## Verification

Each of these is a property with a mutation that must redden it; a claim
written without running its mutation does not go in the report (CLAUDE.md).

**Against a real Worker**, using the resolve hook described above:

1. The pinned 951-byte chunk goes through the pool and comes back as a 2024-byte
   buffer whose first four bytes are `pnts`, byte-identical to what
   `encodePnts` produces on the main thread for the same input.
2. The submitted `compressed` buffer is neutered (`byteLength === 0`) after
   submission, and the returned buffer is not neutered on arrival. Decision 3
   asserted rather than assumed.
3. A `ZeroPointChunkError` raised inside the Worker arrives as a
   `ZeroPointChunkError` with its `code` and its message intact.
4. A non-library throw arrives as `WorkerTaskFailedError` with the original
   message reachable through `cause`.

**Against ports the test controls** (so timing is deterministic):

5. Concurrent posted tasks never exceed `size`.
6. Outstanding leases never exceed `concurrency`; every lease is released
   exactly once across success, failure, pre-post cancellation, post-cancel
   abandonment, worker crash, and `destroy()`. The budget module already
   throws `LeaseAlreadyReleasedError` on a double release, so a double release
   fails loudly rather than needing its own assertion.
7. `deferred` is returned when the budget is full, remembers nothing, and a
   later call succeeds once a lease frees.
8. An abandoned task's eventual `done` is discarded and does not settle a
   promise twice.
9. `destroy()` settles every outstanding promise exactly once, releases every
   lease, and terminates every port. Note the interaction the budget already
   defines: `Budget.destroy()` frees outstanding reservations but still
   accepts a held lease's later `release()`, once — so a pool destroyed
   between a task's admission and its reply must not double-release, and the
   test has to cover that ordering specifically rather than only the quiet
   case.
10. A crashed port fails only its own task; the next task spawns a fresh port.

**Structural:**

11. `entry.ts`'s closure reaches the pipeline and the transform, and reaches
    neither the CRS registry nor `pool.ts`.
12. Every `code` declared under `src/errors/` appears in the wire map.

## Risks

**The absent caller.** `src/cesium-runtime/` does not exist yet, so nothing
exercises this surface the way Cesium will. Two specific things could be
wrong in a way these tests cannot see: whether a per-frame `deferred` retry
actually fits the codec's control flow, and whether the codec can supply the
`DecodeHeader` and `pointCount` at the moment it is handed tile bytes. Both
are answerable only when sub-project 8 is written. If either turns out wrong,
the fix is in the pool's surface, not its internals — which is the cheaper
half to change.

**The resolve hook is test-only.** It makes the tests real, but production
still needs the Rollup bundle OVERVIEW §5 calls for, and nothing here proves
that bundle will work. That gate belongs to the bundling sub-project and
should be run early there, because a Worker bundle that cannot find its WASM
is the classic defect that only shows up in the published package.

## Decisions settled — do not relitigate mid-task

- No `cancel` message. Cancellation is main-thread bookkeeping.
- No `terminate()` on cancellation.
- No unbounded queue; `deferred` goes back to the caller.
- The transform is built per call inside `encodeNode`, unchanged from the
  pipeline sub-project. Changing it requires a measurement, per §7.
- The pool does not construct platform Workers.
- Errors are rebuilt as their original classes, not wrapped in one generic
  error.
