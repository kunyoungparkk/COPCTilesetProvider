import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createBudget } from '../src/budget/index.js';
import { settleWith } from './settled.js';
import { toWire, WorkerTaskFailedError } from '../src/errors/index.js';
import { createWorkerPool } from '../src/worker/pool.js';
import {
  DEFINITION,
  busyPort,
  encodeMessages,
  fakeSpawner,
  readyAll,
  request,
  totalEncodeMessages,
} from './worker-pool-fixtures.js';

/**
 * OVERVIEW §3 Decision 5's "exactly once, whichever way it ends" for the
 * worker pool: abort before posting, abort after posting, a Worker crash, a
 * `failed` init, and `destroy()` all release the same lease exactly once and
 * settle the same promise exactly once.
 */

describe('createWorkerPool lifecycle', () => {
  it('aborting a task that has not been posted removes it from the waiting set, settles it once, releases its lease, and never posts it', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    // The pool's one port (size: 1) is spawned by the first `encode()` but
    // never readied, so both tasks sit in the waiting set — this is what
    // makes `second` verifiably "not yet posted" rather than merely "not
    // yet replied to".
    const first = pool.encode(request());
    const controller = new AbortController();
    const second = pool.encode(request(), controller.signal);
    if (first.verdict !== 'admitted' || second.verdict !== 'admitted') {
      throw new Error('expected both requests to be admitted');
    }

    const before = budget.stats().decode.inUse;
    expect(() => controller.abort()).not.toThrow();

    const settlement = await settleWith(second.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    expect(settlement.reason).toBe(controller.signal.reason);
    expect(budget.stats().decode.inUse).toBe(before - 1);

    // Only now does the pool's one port become ready. With size: 1, only one
    // port will ever exist, so checking totalEncodeMessages here would prove
    // nothing about whether `second` was dropped — there is only one port to
    // dispatch to either way. The real proof comes after this same port frees
    // up again below: only then is there a second opportunity to dispatch,
    // and only a `second` still sitting in the waiting set could take it.
    readyAll(ports);
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected the first task to have been posted');
    const posted = encodeMessages(port)[0];
    if (posted === undefined) throw new Error('expected an encode message');
    const pnts = new ArrayBuffer(4);
    port.reply({ kind: 'done', id: posted.id, pnts });
    await expect(first.pnts).resolves.toBe(pnts);

    // The port is free again. If `second` were still in the waiting set, it
    // would be dispatched to it right now, as a direct result of `first`'s
    // reply freeing the slot — proof it was truly dropped, not merely not
    // yet reached.
    expect(totalEncodeMessages(ports)).toBe(1);
  });

  it('aborting a posted task posts no cancel message, and a late reply for it does not double-release its lease', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const controller = new AbortController();
    const verdict = pool.encode(request(), controller.signal);
    if (verdict.verdict !== 'admitted') throw new Error('expected the request to be admitted');

    readyAll(ports);
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected the task to have been posted');
    const posted = encodeMessages(port)[0];
    if (posted === undefined) throw new Error('expected an encode message');

    controller.abort();
    const settlement = await settleWith(verdict.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    expect(settlement.reason).toBe(controller.signal.reason);

    // There is no `cancel` message in the protocol (protocol.ts) — the abort
    // must not have posted anything beyond the original init/encode pair.
    expect(port.posted.map((message) => message.kind)).toEqual(['init', 'encode']);

    // Queued while the port is still nominally busy with the abandoned
    // task, so it is *waiting* rather than posted — the only way to prove
    // the stale reply's own dispatch() call (not this encode()'s own, which
    // would dispatch it just the same, hiding the very thing this test
    // means to check) is what sends it to the now-freed port.
    const next = pool.encode(request());
    if (next.verdict !== 'admitted') throw new Error('expected the next request to be admitted');
    expect(totalEncodeMessages(ports)).toBe(1); // still just the abandoned task's own encode message

    // The late reply must be discarded rather than release the lease a
    // second time. A bare Promise silently ignores a second resolve/reject —
    // its settled value cannot reveal a double settle on its own — so the
    // only proof available here is that discarding the reply does not
    // throw (the sole path that *would* throw is a second `lease.release()`
    // on an already-released lease) and does not change `inUse` — `next`'s
    // own lease is the only one still outstanding at this point.
    const before = budget.stats().decode.inUse;
    expect(() => port.reply({ kind: 'done', id: posted.id, pnts: new ArrayBuffer(8) })).not.toThrow();
    expect(budget.stats().decode.inUse).toBe(before);

    // The slot really is free again: the stale reply's own dispatch() call
    // — nothing else runs between the reply above and this check — is what
    // sent `next` to this same port.
    expect(totalEncodeMessages(ports)).toBe(2);
    expect(ports).toHaveLength(1);
  });

  describe('a lease is released on every terminal path', () => {
    it('success', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const verdict = pool.encode(request());
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = busyPort(ports);
      if (port === undefined) throw new Error('expected a port to have received the task');
      const task = encodeMessages(port)[0];
      if (task === undefined) throw new Error('expected an encode message');

      const pnts = new ArrayBuffer(4);
      expect(() => port.reply({ kind: 'done', id: task.id, pnts })).not.toThrow();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'fulfilled') throw new Error(`expected a fulfillment, got ${settlement.state}`);
      expect(settlement.value).toBe(pnts);
      expect(budget.stats().decode.inUse).toBe(0);
    });

    it('a `failed` reply', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const verdict = pool.encode(request());
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = busyPort(ports);
      if (port === undefined) throw new Error('expected a port to have received the task');
      const task = encodeMessages(port)[0];
      if (task === undefined) throw new Error('expected an encode message');

      expect(() =>
        port.reply({ kind: 'failed', id: task.id, error: toWire(new Error('laz-perf choked')) }),
      ).not.toThrow();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
      expect(settlement.reason).toBeInstanceOf(WorkerTaskFailedError);
      expect(budget.stats().decode.inUse).toBe(0);
    });

    it('a pre-post abort', async () => {
      const { spawn } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      // size 0 so nothing is ever posted, however long the test waits.
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 0 });

      const controller = new AbortController();
      const verdict = pool.encode(request(), controller.signal);
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');

      expect(() => controller.abort()).not.toThrow();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
      expect(settlement.reason).toBe(controller.signal.reason);
      expect(budget.stats().decode.inUse).toBe(0);
    });

    it('a post-abort with a late `done`', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const controller = new AbortController();
      const verdict = pool.encode(request(), controller.signal);
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = busyPort(ports);
      if (port === undefined) throw new Error('expected a port to have received the task');
      const task = encodeMessages(port)[0];
      if (task === undefined) throw new Error('expected an encode message');

      controller.abort();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
      expect(settlement.reason).toBe(controller.signal.reason);
      expect(budget.stats().decode.inUse).toBe(0);

      expect(() => port.reply({ kind: 'done', id: task.id, pnts: new ArrayBuffer(4) })).not.toThrow();
      expect(budget.stats().decode.inUse).toBe(0);
    });

    it('a post-abort with a late `failed`', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const controller = new AbortController();
      const verdict = pool.encode(request(), controller.signal);
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = busyPort(ports);
      if (port === undefined) throw new Error('expected a port to have received the task');
      const task = encodeMessages(port)[0];
      if (task === undefined) throw new Error('expected an encode message');

      controller.abort();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
      expect(settlement.reason).toBe(controller.signal.reason);
      expect(budget.stats().decode.inUse).toBe(0);

      expect(() =>
        port.reply({ kind: 'failed', id: task.id, error: toWire(new Error('too late')) }),
      ).not.toThrow();
      expect(budget.stats().decode.inUse).toBe(0);
    });

    it('a port error', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const verdict = pool.encode(request());
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = busyPort(ports);
      if (port === undefined) throw new Error('expected a port to have received the task');

      const crash = new Error('worker crashed');
      expect(() => port.raiseError(crash)).not.toThrow();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
      expect(settlement.reason).toBe(crash);
      expect(budget.stats().decode.inUse).toBe(0);
      // The Worker is alive when its error handler fires — it must be
      // terminated here, not merely dropped from the pool's bookkeeping.
      expect(port.terminated).toBe(true);
    });

    it('destroy()', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const verdict = pool.encode(request());
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);

      expect(() => pool.destroy()).not.toThrow();
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
      expect(settlement.reason).toBeInstanceOf(Error);
      expect((settlement.reason as Error).message).toBe('WorkerPool destroyed');
      expect(budget.stats().decode.inUse).toBe(0);
    });
  });

  describe('a task already abandoned by one terminal path meets a second', () => {
    // Every test above exercises exactly one terminal path per task.
    // Ordinary sequences combine two: a camera sweep aborts a posted tile,
    // then the Worker it was posted to crashes, or the provider is torn
    // down while an aborted task's slot is still nominally occupied.
    // `handlePortError` and `destroy()` both guard against re-abandoning a
    // task abandon() already settled — without the guard, `finish()` calls
    // `task.lease.release()` a second time, which throws
    // LeaseAlreadyReleasedError (src/budget/lease.ts).

    it('an aborted, posted task does not double-release its lease when the Worker then crashes', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

      const controller = new AbortController();
      const verdict = pool.encode(request(), controller.signal);
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = busyPort(ports);
      if (port === undefined) throw new Error('expected the task to have been posted');

      // Abandoned by the abort while still posted: its lease is already
      // released, but slot.busy still points at it (handleMessage's own
      // "abandoned" check is what frees the slot, on the real reply that
      // never comes here).
      controller.abort();
      await settleWith(verdict.pnts);
      expect(budget.stats().decode.inUse).toBe(0);

      expect(() => port.raiseError(new Error('worker crashed'))).not.toThrow();
      expect(budget.stats().decode.inUse).toBe(0);
      expect(port.terminated).toBe(true);
    });

    it('an aborted, posted task does not double-release its lease when destroy() follows, and destroy() still finishes every other port', async () => {
      const { spawn, ports } = fakeSpawner();
      const budget = createBudget({ decodeJobs: 4 });
      const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 2 });

      const controller = new AbortController();
      const aborted = pool.encode(request(), controller.signal);
      const other = pool.encode(request());
      if (aborted.verdict !== 'admitted' || other.verdict !== 'admitted') {
        throw new Error('expected both requests to be admitted');
      }
      readyAll(ports);
      expect(ports).toHaveLength(2);

      controller.abort();
      await settleWith(aborted.pnts);
      expect(budget.stats().decode.inUse).toBe(1); // only `other`'s lease remains

      // destroy() must still settle `other` and terminate both ports, even
      // though `aborted`'s slot is already marked abandoned. Without the
      // guard, re-abandoning it throws mid-loop, leaving `other`'s port
      // un-terminated.
      expect(() => pool.destroy()).not.toThrow();
      const otherSettlement = await settleWith(other.pnts);
      if (otherSettlement.state !== 'rejected') {
        throw new Error(`expected a rejection, got ${otherSettlement.state}`);
      }
      expect(budget.stats().decode.inUse).toBe(0);
      expect(ports.every((port) => port.terminated)).toBe(true);
    });
  });

  it('a failed `init` reply removes the dead slot, terminates its port, and fails every task still waiting', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const verdict = pool.encode(request());
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');
    expect(ports).toHaveLength(1);
    const dead = ports[0];
    if (dead === undefined) throw new Error('expected a port to have been spawned');
    const init = dead.posted[0];
    if (init === undefined || init.kind !== 'init') throw new Error('expected an init message');

    // The Worker never became usable, and `definition` cannot change between
    // attempts — a retry on a fresh port would fail the exact same way
    // (OVERVIEW §3 Decision 4's reasoning for a 4xx: a request that is
    // wrong stays wrong). The still-waiting task fails now, with this
    // reply's own error, rather than holding its lease forever.
    expect(() =>
      dead.reply({ kind: 'failed', id: init.id, error: toWire(new Error('init failed')) }),
    ).not.toThrow();

    const settlement = await settleWith(verdict.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    expect(settlement.reason).toBeInstanceOf(WorkerTaskFailedError);
    expect(budget.stats().decode.inUse).toBe(0);

    // The dead Worker is still alive — it merely answered `failed` — so it
    // must be terminated, not just forgotten. And nothing here spawned a
    // replacement on its own: attempts are bounded by demand, not by replies.
    expect(dead.terminated).toBe(true);
    expect(ports).toHaveLength(1);
    expect(dead.posted.map((message) => message.kind)).toEqual(['init']);

    // A later `encode()` may still try again, on a fresh port.
    const retry = pool.encode(request());
    if (retry.verdict !== 'admitted') throw new Error('unreachable');
    expect(ports).toHaveLength(2);
    const fresh = ports[1];
    if (fresh === undefined) throw new Error('expected a fresh port to have been spawned');
    const freshInit = fresh.posted[0];
    if (freshInit === undefined || freshInit.kind !== 'init') {
      throw new Error('expected an init message on the fresh port');
    }
    fresh.reply({ kind: 'ready', id: freshInit.id });

    const task = encodeMessages(fresh)[0];
    if (task === undefined) throw new Error('expected the retry to have been posted to the fresh port');
    const pnts = new ArrayBuffer(4);
    fresh.reply({ kind: 'done', id: task.id, pnts });
    const retrySettlement = await settleWith(retry.pnts);
    if (retrySettlement.state !== 'fulfilled') throw new Error(`expected a fulfillment, got ${retrySettlement.state}`);
    expect(retrySettlement.value).toBe(pnts);
  });

  it('repeated failed inits terminate each dead port instead of leaking Worker threads or spawning without bound', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 100 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const ROUNDS = 10;
    for (let i = 0; i < ROUNDS; i++) {
      const verdict = pool.encode(request());
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      const port = ports.at(-1);
      if (port === undefined) throw new Error('expected a port to have been spawned');
      const init = port.posted[0];
      if (init === undefined || init.kind !== 'init') throw new Error('expected an init message');
      port.reply({ kind: 'failed', id: init.id, error: toWire(new Error('init failed')) });
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    }

    // Exactly one port per attempt — demand-bounded, not reply-bounded — and
    // every one of them terminated, not merely dropped from bookkeeping.
    expect(ports).toHaveLength(ROUNDS);
    expect(ports.every((port) => port.terminated)).toBe(true);
  });

  it("a port's onError fails only that port's task; the next encode spawns a fresh port and succeeds", async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const first = pool.encode(request());
    if (first.verdict !== 'admitted') throw new Error('unreachable');
    readyAll(ports);
    expect(ports).toHaveLength(1);
    const dead = ports[0];
    if (dead === undefined) throw new Error('expected a port to have been spawned');

    const crash = new Error('worker crashed');
    dead.raiseError(crash);
    const settlement = await settleWith(first.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    expect(settlement.reason).toBe(crash);
    expect(budget.stats().decode.inUse).toBe(0);
    expect(dead.terminated).toBe(true);

    const second = pool.encode(request());
    if (second.verdict !== 'admitted') throw new Error('unreachable');
    // A fresh port, not the dead one — dispatch must not have believed the
    // dead port was still usable.
    expect(ports).toHaveLength(2);
    readyAll(ports);

    const fresh = ports[1];
    if (fresh === undefined) throw new Error('expected a second port to have been spawned');
    const task = encodeMessages(fresh)[0];
    if (task === undefined) throw new Error('expected the second task to land on the fresh port');
    const pnts = new ArrayBuffer(4);
    fresh.reply({ kind: 'done', id: task.id, pnts });
    const secondSettlement = await settleWith(second.pnts);
    if (secondSettlement.state !== 'fulfilled') throw new Error(`expected a fulfillment, got ${secondSettlement.state}`);
    expect(secondSettlement.value).toBe(pnts);

    // The crashed port never received anything beyond its original init/encode pair.
    expect(dead.posted.map((message) => message.kind)).toEqual(['init', 'encode']);
  });

  it('destroy() settles every outstanding promise exactly once, releases every lease, and terminates every port', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    // One posted (the pool's only port, readied) and one left waiting.
    const posted = pool.encode(request());
    if (posted.verdict !== 'admitted') throw new Error('unreachable');
    readyAll(ports);
    const waiting = pool.encode(request());
    if (waiting.verdict !== 'admitted') throw new Error('unreachable');
    expect(totalEncodeMessages(ports)).toBe(1);
    // Pinned before the `every` check below, which would otherwise pass
    // vacuously if `ports` turned out to be empty.
    expect(ports).toHaveLength(1);

    expect(() => pool.destroy()).not.toThrow();

    const postedSettlement = await settleWith(posted.pnts);
    if (postedSettlement.state !== 'rejected') throw new Error(`expected a rejection, got ${postedSettlement.state}`);
    expect((postedSettlement.reason as Error).message).toBe('WorkerPool destroyed');

    const waitingSettlement = await settleWith(waiting.pnts);
    if (waitingSettlement.state !== 'rejected') {
      throw new Error(`expected a rejection, got ${waitingSettlement.state}`);
    }
    expect((waitingSettlement.reason as Error).message).toBe('WorkerPool destroyed');

    expect(budget.stats().decode.inUse).toBe(0);
    expect(ports.every((port) => port.terminated)).toBe(true);
  });

  it("does not double-release when the budget itself is destroyed between a task's admission and its reply", async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const verdict = pool.encode(request());
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');
    readyAll(ports);
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected a port to have received the task');
    const task = encodeMessages(port)[0];
    if (task === undefined) throw new Error('expected an encode message');

    // The budget, not the pool, is destroyed here. `Budget.destroy()` frees
    // this task's reservation immediately and marks its lease 'adopted' —
    // a later `release()` on it is still accepted, once (src/budget/lease.ts).
    budget.destroy();
    expect(budget.stats().decode.inUse).toBe(0);

    const pnts = new ArrayBuffer(4);
    expect(() => port.reply({ kind: 'done', id: task.id, pnts })).not.toThrow();
    const settlement = await settleWith(verdict.pnts);
    if (settlement.state !== 'fulfilled') throw new Error(`expected a fulfillment, got ${settlement.state}`);
    expect(settlement.value).toBe(pnts);
    expect(budget.stats().decode.inUse).toBe(0);
  });

  it("an encode after destroy() is rejected with the budget's own 'destroyed' reason", () => {
    const { spawn } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    pool.destroy();
    const verdict = pool.encode(request());
    expect(verdict).toEqual({ verdict: 'rejected', reason: 'destroyed' });
  });

  it('a non-Error abort reason is normalized into an Error, not rejected with the raw value', async () => {
    const { spawn } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 0 });

    const controller = new AbortController();
    const verdict = pool.encode(request(), controller.signal);
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');

    controller.abort('camera moved on');
    const settlement = await settleWith(verdict.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    // The trap: `rejects.toThrow('camera moved on')` passes whether or not
    // the pool wrapped the raw string in an `Error` — Vitest's `toThrow`
    // matches a rejection's stringified value regardless of its type. Only
    // checking the rejection's *type* distinguishes `toAbortError`'s
    // fallback from a pool that just re-threw `signal.reason` unchanged.
    expect(settlement.reason).toBeInstanceOf(Error);
    expect((settlement.reason as Error).message).toBe('camera moved on');
  });

  it('a shared AbortSignal does not accumulate a listener per completed task', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 20 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });
    const controller = new AbortController();

    const ROUNDS = 5;
    for (let i = 0; i < ROUNDS; i++) {
      const verdict = pool.encode(request(), controller.signal);
      if (verdict.verdict !== 'admitted') throw new Error('unreachable');
      readyAll(ports);
      const port = ports[0];
      if (port === undefined) throw new Error("expected the pool's one port to exist");
      const task = encodeMessages(port).at(-1);
      if (task === undefined) throw new Error('expected the task to have been posted');
      port.reply({ kind: 'done', id: task.id, pnts: new ArrayBuffer(4) });
      const settlement = await settleWith(verdict.pnts);
      if (settlement.state !== 'fulfilled') throw new Error(`expected a fulfillment, got ${settlement.state}`);
    }

    expect(ports).toHaveLength(1);
    // None of the five completed tasks left its abort listener attached —
    // `getEventListeners` reads the signal's own listener list directly, so
    // this cannot pass merely because a leaked listener happens to be
    // harmless.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
