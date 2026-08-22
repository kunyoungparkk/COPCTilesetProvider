import type { Budget, Lease, RejectionReason } from '../budget/index.js';
import { DecodeJobNotAdmittedError, fromWire } from '../errors/index.js';
import type { DecodeHeader } from './index.js';
import type { FromWorker, WorkerPort } from './protocol.js';

// Re-exported, not redeclared: `WorkerPort` is the two-realm message
// protocol's own type (protocol.ts), and callers of this module construct
// one to pass as `WorkerPoolOptions.spawn`'s result.
export type { WorkerPort } from './protocol.js';

export interface EncodeRequest {
  /**
   * The compressed chunk bytes. `WorkerPool.encode` transfers this buffer to
   * a Worker (OVERVIEW §3 Decision 3) rather than cloning it, which detaches
   * it (`byteLength` 0) as soon as a port actually posts it — not
   * necessarily within the `encode()` call itself, since a request admitted
   * while every port is busy is only posted later, once one frees up. A
   * `deferred` verdict never reaches a port, so the same request is safe to
   * resubmit unchanged; an `admitted` one is not — resubmitting the same
   * `EncodeRequest` after its first submission was admitted risks handing a
   * second `post()` a buffer already detached by the first.
   */
  readonly compressed: ArrayBuffer;
  readonly header: DecodeHeader;
  readonly pointCount: number;
}

/**
 * `verdict` and `RejectionReason` are the budget's own, not a second
 * vocabulary for the same three outcomes — this verdict *is*
 * `Budget.acquireDecodeJob`'s verdict with a promise attached on the
 * `admitted` branch.
 */
export type EncodeVerdict =
  | { readonly verdict: 'admitted'; readonly pnts: Promise<ArrayBuffer> }
  | { readonly verdict: 'deferred' }
  | { readonly verdict: 'rejected'; readonly reason: RejectionReason };

/** `createWorkerPool`'s constructor options. `spawn` and `definition` are fixed for the pool's whole lifetime — see `spawnSlot`'s own doc for what that means when either one fails. */
export interface WorkerPoolOptions {
  readonly spawn: () => WorkerPort;
  readonly definition: string;
  readonly budget: Budget;
  readonly size?: number;
}

/** Admits decode work against a `Budget` and posts it to a small pool of `WorkerPort`s, settling each task's promise exactly once regardless of which terminal path gets there (OVERVIEW §3 Decision 5). */
export interface WorkerPool {
  /**
   * Admits `request` against the budget and, once a port is free and ready,
   * posts it for decoding.
   *
   * `signal`, aborted before or after this call, cancels the task: its
   * lease is released immediately either way (OVERVIEW §3 Decision 5). A
   * task not yet posted is simply forgotten. A task already posted keeps its
   * port occupied until the Worker's real reply arrives — there is no
   * `cancel` message (see `protocol.ts`) — so only the lease, not the port,
   * is freed right away.
   *
   * `request.compressed` is transferred, not cloned, the moment a port
   * actually posts it (see `EncodeRequest.compressed`) — which for an
   * `admitted` verdict may happen synchronously within this call, or later,
   * once a busy port frees up.
   */
  encode(request: EncodeRequest, signal?: AbortSignal): EncodeVerdict;
  /**
   * Like `encode`, but waits out a `deferred` verdict instead of returning
   * it, retrying once a decode-job lease is released, until either admitted
   * or permanently `rejected`.
   *
   * `Budget.acquireRangeRequest`'s `deferred` has somewhere to go:
   * `ScheduledRangeResource.fetchArrayBuffer` returns `undefined`, and
   * Cesium's own contract re-asks the tile next frame
   * (`Cesium3DTile.js:1300-1330`). A decode job's caller,
   * `Cesium3DTile.makeContent`'s codec branch, has no equivalent channel — it
   * awaits `codec.createContent(...)` as a `Promise<Cesium3DTileContent>`,
   * and a rejection there sends the tile straight to
   * `Cesium3DTileContentState.FAILED`. FAILED is terminal: a tile only ever
   * re-enters `Cesium3DTilesetCache` (and so only ever becomes eligible for
   * `unloadTile`, the one path back to UNLOADED) from `process()`, gated on
   * `this._content.ready` — a FAILED tile has no `_content` and never reaches
   * that gate. So there is no retry left for a caller to make; this method
   * is the retry.
   *
   * Resubmitting the same `request` on each attempt is sound by
   * `EncodeRequest.compressed`'s own contract: "a `deferred` verdict never
   * reaches a port, so the same request is safe to resubmit unchanged."
   *
   * `signal`, aborted while still waiting for a lease, rejects immediately
   * without ever touching the budget — the same "never posted, never even
   * waiting" treatment `encode` gives an abort that lands before its own
   * task is queued.
   */
  encodeWhenAdmitted(request: EncodeRequest, signal?: AbortSignal): Promise<ArrayBuffer>;
  /**
   * Fails every outstanding task, releases every lease, terminates every
   * port, and rejects further admission. Each task is settled exactly once
   * regardless of whether `destroy()` or its own reply gets there first.
   * Also settles every `encodeWhenAdmitted` call still waiting for a lease —
   * left unsettled, one would outlive the pool and its tile would never
   * reach `tilesLoaded`.
   */
  destroy(): void;
}

// OVERVIEW §7: worker pool size 4. `Budget`'s own `decodeJobs` limit (§7:
// pool size × 2) bounds how much work `encode` can *admit*; `size` here
// bounds how much of that admitted work `dispatch` can have posted to a
// port at once. This constant is only the default port count.
export const DEFAULT_POOL_SIZE = 4;

/**
 * One admitted `encode` call, from the moment its lease is granted to the
 * moment its promise settles.
 *
 * `abandoned` is set by `finish`, the one place a task's lease is released —
 * so it is true from that point on regardless of which terminal path got
 * there (success, a `failed` reply, abort, a port error, or `destroy()`). A
 * stale reply for a posted-then-aborted task, or a signal that fires after
 * the task already settled some other way, both read this flag to discard
 * themselves instead of settling or releasing a second time.
 *
 * `detachAbortListener` undoes `encode`'s own `signal.addEventListener` —
 * `{ once: true }` alone only stops a *second* invocation, it does not
 * remove a listener that never fired, so a task that settles some other way
 * while its signal never aborts would otherwise sit on that signal forever.
 * `finish` calls it alongside the lease release, so it is torn down on
 * every terminal path, not only the abort one. `undefined` for a task built
 * without a `signal`.
 */
interface Task {
  readonly id: number;
  readonly request: EncodeRequest;
  readonly lease: Lease;
  readonly settle: (result: ArrayBuffer) => void;
  readonly fail: (error: Error) => void;
  abandoned: boolean;
  detachAbortListener: (() => void) | undefined;
}

/** One spawned port and what it is doing right now. */
interface Slot {
  readonly port: WorkerPort;
  readonly initId: number;
  ready: boolean;
  busy: Task | undefined;
}

/**
 * One `encodeWhenAdmitted` call still waiting for a decode-job lease.
 *
 * Distinct from `Task`: a `Waiter` has never touched the budget, so there is
 * no lease to release and no port to occupy — only `request`, and enough to
 * settle its promise or detach its own abort listener once it either gets a
 * turn or is cancelled first.
 */
interface Waiter {
  readonly request: EncodeRequest;
  readonly resolve: (pnts: ArrayBuffer) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  detachAbortListener: (() => void) | undefined;
}

/**
 * Builds a pool that admits decode work against `options.budget` and posts it
 * to lazily spawned `WorkerPort`s.
 *
 * The budget is the queue: OVERVIEW §3 Decision 5's three-way admission
 * (admitted/deferred/rejected) is this pool's only queueing for `encode`.
 * `encode` holds only the tasks a `Budget.acquireDecodeJob` lease has already
 * been granted for, and holds them only until a port is free — it never
 * queues a `deferred` request, because a `deferred` verdict means the
 * caller's own next call is the retry. `encodeWhenAdmitted` is the one
 * caller that makes that next call itself, via its own `deferredWaiters`
 * queue (see its own doc on `WorkerPool`).
 */
export function createWorkerPool(options: WorkerPoolOptions): WorkerPool {
  const { spawn, definition, budget } = options;
  const size = options.size ?? DEFAULT_POOL_SIZE;

  const slots: Slot[] = [];
  // Tasks holding a lease, waiting for a free ready port. Never holds a
  // `deferred` or `rejected` request — those are returned to the caller and
  // forgotten here (see the "defers when the budget defers, posts nothing,
  // and remembers nothing" test).
  const waiting: Task[] = [];
  // Requests waiting on `encodeWhenAdmitted` for a decode-job lease, in the
  // order they arrived. Drained one at a time in `finish`, the one place a
  // lease is released — precisely one unit of capacity just freed, so only
  // the head is worth retrying; anything behind it is still exactly as
  // unadmitted as it was.
  const deferredWaiters: Waiter[] = [];
  let nextId = 0;
  let destroyed = false;

  /**
   * `spawn` cannot make a Worker, or the port it just made cannot even
   * accept the `init` message — either way this attempt never produced a
   * slot. Unlike `handleMessage`'s `failed`-init branch — whose own comment
   * says "there is no healthy sibling in this failure mode", true there
   * because `init` fails only on the one pool-wide `definition` — a `spawn`
   * or `post` failure says nothing about any *other* slot: a sibling
   * spawned earlier can be perfectly healthy and busy on its own task right
   * now. So the waiting backlog is only failed when this was the pool's
   * last hope of ever draining it — `slots.length === 0` — and otherwise
   * left alone, for a healthy sibling (or a later `encode()`) to serve.
   */
  function failIfHopeless(error: Error): void {
    if (slots.length > 0) return;
    const doomed = waiting.splice(0, waiting.length);
    for (const task of doomed) {
      abandon(task, error);
    }
  }

  /**
   * Normalizes any thrown or `AbortSignal.reason` value into an `Error`.
   * Neither is guaranteed to already be one — a thrown value can be
   * anything, and `reason` is typed `any` because a caller may pass any
   * value to `controller.abort(reason)`.
   */
  function toError(thrown: unknown): Error {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  }

  function spawnSlot(): void {
    let port: WorkerPort;
    try {
      port = spawn();
    } catch (thrown) {
      failIfHopeless(toError(thrown));
      return;
    }
    const initId = nextId++;
    const slot: Slot = { port, initId, ready: false, busy: undefined };
    slots.push(slot);
    port.onMessage((message) => handleMessage(slot, message));
    port.onError((error) => handlePortError(slot, error));
    try {
      port.post({ kind: 'init', id: initId, definition }, []);
    } catch (thrown) {
      // `init` never reached the Worker: this slot never became usable, the
      // same outcome as a `failed` init reply, just discovered synchronously
      // instead of over a message.
      removeSlot(slot);
      failIfHopeless(toError(thrown));
    }
  }

  /**
   * Drops a dead port from the pool and terminates it. `dispatch` treats a
   * shrunken `slots` as room to spawn a replacement. Terminating here (not
   * only in `destroy()`) matters because a `failed` init or an `onError`
   * leaves the underlying Worker thread itself alive — it merely reported a
   * problem — so leaving `slots` as the only reference to it would leak
   * that thread and its laz-perf WASM instance.
   */
  function removeSlot(slot: Slot): void {
    const index = slots.indexOf(slot);
    if (index !== -1) slots.splice(index, 1);
    slot.port.terminate();
  }

  /** Assigns as many waiting tasks as there are free, ready ports right now. */
  function dispatch(): void {
    while (waiting.length > 0) {
      const slot = slots.find((candidate) => candidate.ready && candidate.busy === undefined);
      if (slot === undefined) {
        // No free, ready port exists right now. Growing the pool is not the
        // only other way one can become available: a busy slot frees itself
        // and calls dispatch() again, and so does a not-yet-ready slot, via
        // handleMessage's `ready` branch. `unassigned` counts every slot not
        // currently busy, ready or not — each one is capacity already paid
        // for (a laz-perf WASM instance mid-startup) and arriving on its
        // own, so spawning is only worth it when there is more waiting work
        // than that already covers.
        const unassigned = slots.filter((candidate) => candidate.busy === undefined).length;
        if (slots.length < size && waiting.length > unassigned) spawnSlot();
        return;
      }
      const task = waiting.shift();
      if (task === undefined) return; // unreachable: the loop guard just checked this
      slot.busy = task;
      try {
        slot.port.post(
          {
            kind: 'encode',
            id: task.id,
            compressed: task.request.compressed,
            header: task.request.header,
            pointCount: task.request.pointCount,
          },
          [task.request.compressed],
        );
      } catch (thrown) {
        // The port accepted `init` but not this `encode` — a non-cloneable
        // payload (a detached buffer, an unusable header) or a port that
        // broke between the two. Either way this task never reached the
        // Worker, so it is failed the same way a crashed port's task is
        // (`handlePortError`): the slot is dropped, not left busy forever,
        // and only this one task is doomed — a sibling waiting task may
        // still succeed on a different port.
        slot.busy = undefined;
        removeSlot(slot);
        // `post` itself can run caller code that settles `task` first — a
        // `WorkerPort` is a public option, so a third-party one could abort
        // `task`'s own signal from inside `post` before throwing. `finish`
        // already ran in that case, so abandoning it again would release its
        // lease a second time. `handlePortError` and `destroy()` guard the
        // same way for the same reason.
        if (!task.abandoned) {
          abandon(task, toError(thrown));
        }
      }
    }
  }

  /**
   * The one place a task's lease is released — every terminal path routes
   * here. Also where `abandoned` becomes true, so a late reply or a
   * late-firing abort signal can tell this task is already settled.
   */
  function finish(task: Task): void {
    task.abandoned = true;
    task.detachAbortListener?.();
    task.lease.release();
    admitWaiters();
    dispatch();
  }

  /**
   * Retries the head of `deferredWaiters` now that a decode-job lease was
   * just released. Stops the moment a retry itself comes back `deferred` —
   * exactly one lease was freed by this call, so a second `deferred` means
   * someone else already took it (or nothing changed), and every waiter
   * behind the head is untouched either way.
   *
   * The head is removed from the queue with `shift()` BEFORE `admitRequest`
   * runs, not after — `admitRequest` can re-enter this very function
   * synchronously (`dispatch()` -> `port.post()` throws, or a third-party
   * port aborts its own task from inside `post()`, either way ->
   * `abandon` -> `finish` -> `admitWaiters`), and at that point the released
   * lease is real room this same waiter would otherwise still be sitting at
   * index 0 to claim a second time — one lease, two admissions, the exact
   * thing `EncodeRequest.compressed`'s own contract rules out for an already-
   * admitted request. Doing the removal after `admitRequest` returns is worse
   * than double-admitting the head: the positional `shift()` then discards
   * whatever waiter the re-entrant call left at index 0, which is not the one
   * this call started with — a different, unrelated waiter, evicted from the
   * queue without ever being settled, invisible even to `destroy()` once it
   * is off the array. Removing first and only putting it back on the one
   * outcome that never re-enters (`deferred`) is what keeps each waiter's
   * removal and its own single settlement paired.
   */
  function admitWaiters(): void {
    while (deferredWaiters.length > 0) {
      const waiter = deferredWaiters.shift();
      if (waiter === undefined) return; // unreachable: the loop guard just checked this
      const verdict = admitRequest(waiter.request, waiter.signal);
      if (verdict.verdict === 'deferred') {
        // Still no room. `admitRequest` cannot have re-entered this function
        // on this branch — it returns before ever touching `dispatch()` or a
        // port — so putting the same waiter back at the front is exactly
        // undoing the `shift()` above, not a race with anything else that
        // may have run meanwhile.
        deferredWaiters.unshift(waiter);
        return;
      }
      waiter.detachAbortListener?.();
      if (verdict.verdict === 'admitted') {
        verdict.pnts.then(waiter.resolve, waiter.reject);
      } else {
        waiter.reject(new DecodeJobNotAdmittedError(verdict.reason));
      }
    }
  }

  /** Fails `task` with `error` and finishes it. Shared by every path that fails a task outright: abort, a port error, a failed `init`, and `destroy()`. */
  function abandon(task: Task, error: Error): void {
    task.fail(error);
    finish(task);
  }

  /**
   * Cancels a task the caller no longer wants. If it is still waiting, it is
   * dropped and never posted. If it was already posted, its slot is left
   * untouched — the Worker's slot, not the budget's capacity, is what is
   * still occupied (OVERVIEW §3 Decision 5) — so only the lease comes back
   * now; the slot frees itself when the stale reply lands (`handleMessage`'s
   * `abandoned` check).
   */
  function abortTask(task: Task, reason: unknown): void {
    if (task.abandoned) return; // already settled some other way
    const waitIndex = waiting.indexOf(task);
    if (waitIndex !== -1) waiting.splice(waitIndex, 1);
    abandon(task, toError(reason));
  }

  function handlePortError(slot: Slot, error: Error): void {
    removeSlot(slot);
    const task = slot.busy;
    slot.busy = undefined;
    // A crash between tasks (nothing assigned) or after this task was
    // already abandoned needs no settling — either way, there is nothing
    // left to fail.
    if (task !== undefined && !task.abandoned) {
      abandon(task, error);
    }
  }

  function handleMessage(slot: Slot, message: FromWorker): void {
    if (message.kind === 'ready') {
      // A reply for a different init than this slot's own — for example one
      // sent to another slot and somehow delivered here — must not mark
      // this slot ready, the same way `done`/`failed` below only resolve
      // the task whose id matches what this slot was actually given.
      if (message.id !== slot.initId) return;
      slot.ready = true;
      dispatch();
      return;
    }

    if (message.kind === 'failed' && message.id === slot.initId) {
      // The Worker never became usable. `definition` is fixed for the whole
      // pool's lifetime, so it fails the exact same way on a replacement —
      // respawning immediately would ask the same question and expect a
      // different answer, the same reasoning OVERVIEW §3 Decision 4 already
      // applies to a 4xx (a request that is wrong stays wrong). Every task
      // still waiting for a port fails now, with this reply's own error,
      // rather than holding its lease forever on a retry that cannot
      // succeed either. Nothing here spawns a replacement: a later
      // `encode()` may still try again on a fresh port, so attempts stay
      // bounded by demand rather than by replies.
      //
      // This also fails tasks a sibling port might have been about to take,
      // which sounds harsh until you look at what can raise it: `init` fails
      // only when `createTransformFromDefinition` throws, a pure function of
      // that one pool-wide definition. A sibling that has not answered yet
      // will fail identically when it does. There is no healthy sibling in
      // this failure mode.
      removeSlot(slot);
      const doomed = waiting.splice(0, waiting.length);
      for (const task of doomed) {
        abandon(task, fromWire(message.error));
      }
      return;
    }

    const task = slot.busy;
    // A `done`/`failed` for a slot with nothing assigned, or for an id that
    // does not match what is assigned, is not this pool's to resolve.
    if (task === undefined || task.id !== message.id) return;

    slot.busy = undefined;
    if (task.abandoned) {
      // This task already finished — aborted while posted, or failed by
      // `destroy()` while still posted; either way `slot.busy` was
      // deliberately left pointing at it until this real reply arrived. Its
      // lease was already released and its promise already settled. This
      // reply only means the Worker finally finished the work nobody wants
      // anymore — the slot is what was still occupied, and it is free now.
      dispatch();
      return;
    }

    if (message.kind === 'done') {
      task.settle(message.pnts);
    } else {
      task.fail(fromWire(message.error));
    }
    finish(task);
  }

  /**
   * `encode`'s actual body, named so `admitWaiters` can call it again for a
   * queued request — `WorkerPool.encode`'s own public signature is just this
   * function assigned below.
   */
  function admitRequest(request: EncodeRequest, signal?: AbortSignal): EncodeVerdict {
    if (destroyed) {
      return { verdict: 'rejected', reason: 'destroyed' };
    }

    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') {
      return admission;
    }

    const id = nextId++;
    // `resolve`/`reject` are only captured here — the executor does no
    // work of its own. `dispatch()` can spawn a Worker and start a WASM
    // instance (`spawnSlot`), which is real work with no business running
    // inside a `new Promise` executor, and Cesium calls `encode()` on the
    // render path.
    let settle!: (result: ArrayBuffer) => void;
    let fail!: (error: Error) => void;
    const pnts = new Promise<ArrayBuffer>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const task: Task = {
      id,
      request,
      lease: admission.lease,
      settle,
      fail,
      abandoned: false,
      detachAbortListener: undefined,
    };

    if (signal?.aborted) {
      // Aborted before this call ever queued it: never posted, never even
      // waiting.
      abandon(task, toError(signal.reason));
      return { verdict: 'admitted', pnts };
    }
    if (signal !== undefined) {
      const onAbort = (): void => abortTask(task, signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      task.detachAbortListener = () => signal.removeEventListener('abort', onAbort);
    }

    waiting.push(task);
    dispatch();
    return { verdict: 'admitted', pnts };
  }

  /**
   * `WorkerPool.encodeWhenAdmitted`'s actual body — see that interface's own
   * doc for why it waits instead of returning a `deferred` verdict.
   */
  function encodeWhenAdmitted(request: EncodeRequest, signal?: AbortSignal): Promise<ArrayBuffer> {
    const verdict = admitRequest(request, signal);
    if (verdict.verdict === 'admitted') {
      return verdict.pnts;
    }
    if (verdict.verdict === 'rejected') {
      return Promise.reject(new DecodeJobNotAdmittedError(verdict.reason));
    }

    return new Promise<ArrayBuffer>((resolve, reject) => {
      if (signal?.aborted) {
        // Aborted before this call ever queued it: never touched the budget,
        // never even waiting — the same treatment `admitRequest` gives this
        // case for a task that already has a lease.
        reject(toError(signal.reason));
        return;
      }

      const waiter: Waiter = { request, resolve, reject, signal, detachAbortListener: undefined };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = deferredWaiters.indexOf(waiter);
          if (index !== -1) deferredWaiters.splice(index, 1);
          reject(toError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detachAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      deferredWaiters.push(waiter);
    });
  }

  return {
    encode: admitRequest,
    encodeWhenAdmitted,

    destroy(): void {
      // Flips the one flag `admitRequest` checks, so no further work is
      // admitted from here on. `dispatch()` needs no flag of its own: the
      // very next step below empties `waiting`, and nothing can refill it
      // once `destroyed` is true, so `dispatch()`'s own loop condition
      // already stops it from acting on anything post-destroy.
      destroyed = true;

      // `encodeWhenAdmitted` callers still waiting for a lease never touched
      // the budget either — settling them is exactly as simple, and just as
      // necessary: left pending, one would outlive this pool entirely. Drained
      // BEFORE `waiting` below on purpose: abandoning an admitted task's own
      // lease calls `finish()`, which calls `admitWaiters()` — if any
      // `deferredWaiters` were still queued at that point, that cascade would
      // drain them itself (through `admitRequest`, now returning `destroyed`)
      // before this loop ever ran, settling them with `DecodeJobNotAdmittedError`
      // instead of this plain one — correct either way, but which one a given
      // waiter gets would then depend on how many unrelated tasks happened to
      // be in `waiting` at the same moment. Draining this queue first removes
      // that dependency entirely: by the time any cascade could reach
      // `admitWaiters()`, there is nothing left in it to drain.
      const stillDeferred = deferredWaiters.splice(0, deferredWaiters.length);
      for (const waiter of stillDeferred) {
        waiter.detachAbortListener?.();
        waiter.reject(new Error('WorkerPool destroyed'));
      }

      // Waiting tasks were never posted, so failing them is the whole story.
      const stillWaiting = waiting.splice(0, waiting.length);
      for (const task of stillWaiting) {
        abandon(task, new Error('WorkerPool destroyed'));
      }

      // Posted tasks' ports are terminated regardless; a task already
      // abandoned by an earlier abort was already failed and its lease
      // already released, so only a still-live one needs settling here.
      for (const slot of slots) {
        const task = slot.busy;
        if (task !== undefined && !task.abandoned) {
          abandon(task, new Error('WorkerPool destroyed'));
        }
        slot.port.terminate();
      }
    },
  };
}
