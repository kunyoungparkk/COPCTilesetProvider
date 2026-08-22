import type { Budget, Lease, RejectionReason } from '../budget/index.js';
import { fromWire } from '../errors/index.js';
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
   * Fails every outstanding task, releases every lease, terminates every
   * port, and rejects further admission. Each task is settled exactly once
   * regardless of whether `destroy()` or its own reply gets there first.
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
 * Builds a pool that admits decode work against `options.budget` and posts it
 * to lazily spawned `WorkerPort`s.
 *
 * The budget is the queue: OVERVIEW §3 Decision 5's three-way admission
 * (admitted/deferred/rejected) is this pool's only queueing. This pool holds
 * only the tasks a `Budget.acquireDecodeJob` lease has already been granted
 * for, and holds them only until a port is free — it never queues a
 * `deferred` request, because a `deferred` verdict means the caller's own
 * next call is the retry.
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
    dispatch();
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

  return {
    encode(request, signal) {
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
    },

    destroy(): void {
      // Flips the one flag `encode` checks, so no further work is admitted
      // from here on. `dispatch()` needs no flag of its own: the very next
      // step below empties `waiting`, and nothing can refill it once
      // `destroyed` is true, so `dispatch()`'s own loop condition already
      // stops it from acting on anything post-destroy.
      destroyed = true;

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
