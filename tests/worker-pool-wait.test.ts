import { describe, expect, it } from 'vitest';
import { createBudget } from '../src/budget/index.js';
import { DecodeJobNotAdmittedError } from '../src/errors/index.js';
import { createWorkerPool } from '../src/worker/pool.js';
import type { ToWorker } from '../src/worker/protocol.js';
import { settleWith } from './settled.js';
import {
  DEFINITION,
  FakePort,
  busyPort,
  encodeMessages,
  fakeSpawner,
  readyAll,
  request,
  totalEncodeMessages,
} from './worker-pool-fixtures.js';

/**
 * A `FakePort` whose `post()` succeeds for every message except the second
 * `encode` it is ever handed, which throws. In a single-port pool this is
 * always the retry `admitWaiters()` makes for a queued waiter, once the
 * first task's own (successful) encode has freed its lease — the shape
 * `admitWaiters`'s own doc comment names: `dispatch()` -> `port.post()`
 * throwing -> `abandon` -> `finish` -> `admitWaiters()` again, synchronously,
 * before the outer call has done anything with its own waiter beyond calling
 * `admitRequest`.
 */
class ThrowsOnSecondEncodePort extends FakePort {
  private encodeCount = 0;

  override post(message: ToWorker, transfer: readonly ArrayBuffer[]): void {
    if (message.kind === 'encode') {
      this.encodeCount += 1;
      if (this.encodeCount >= 2) {
        throw new Error('port broke on its second encode message');
      }
    }
    super.post(message, transfer);
  }
}

/**
 * `WorkerPool.encodeWhenAdmitted` exists because `Cesium3DTile.makeContent`'s
 * codec branch has no "ask again next frame" contract the way
 * `ScheduledRangeResource.fetchArrayBuffer` does: a tile that throws inside
 * `createContent` goes straight to `Cesium3DTileContentState.FAILED`, which
 * — measured against the installed Cesium source — is terminal (a tile only
 * ever re-enters the tileset cache, and so only ever becomes eligible for
 * `unloadTile`, once its content is actually ready; a FAILED tile has none).
 * So a transient `deferred` decode-job verdict has to be waited out here
 * rather than handed back for someone else to retry.
 */

describe('WorkerPool.encodeWhenAdmitted', () => {
  it('admits immediately when the budget has room, the same as encode().pnts', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const promise = pool.encodeWhenAdmitted(request());
    readyAll(ports);
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected a port to have received the encode message');
    const task = encodeMessages(port)[0];
    if (task === undefined) throw new Error('expected an encode message');

    const pnts = new ArrayBuffer(4);
    port.reply({ kind: 'done', id: task.id, pnts });

    await expect(promise).resolves.toBe(pnts);
  });

  it('waits out a deferred verdict, retrying only when a decode-job lease is released — never resubmitted by the caller', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 1 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    // Occupies the pool's only decode-job lease.
    const first = pool.encode(request());
    if (first.verdict !== 'admitted') throw new Error('expected the first request to be admitted');
    readyAll(ports);
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected the first task to have been posted');

    // The budget has no room left, so this queues rather than posting.
    const waiting = pool.encodeWhenAdmitted(request());
    let settlement = await settleWith(waiting);
    expect(settlement.state).toBe('pending');
    // Confirms it really is queued, not posted: still exactly one `encode`
    // message on the wire, the first request's own.
    expect(totalEncodeMessages(ports)).toBe(1);

    // Releasing the first task's lease is what frees the room the queued
    // request needed — `encodeWhenAdmitted` never re-calls itself; only
    // `finish()`'s own `admitWaiters()` does.
    port.reply({ kind: 'done', id: encodeMessages(port)[0]?.id ?? -1, pnts: new ArrayBuffer(1) });

    expect(totalEncodeMessages(ports)).toBe(2);
    settlement = await settleWith(waiting);
    expect(settlement.state).toBe('pending'); // admitted and posted, but not yet replied to

    const second = encodeMessages(port)[1];
    if (second === undefined) throw new Error('expected a second encode message');
    const secondPnts = new ArrayBuffer(2);
    port.reply({ kind: 'done', id: second.id, pnts: secondPnts });

    await expect(waiting).resolves.toBe(secondPnts);
  });

  it('rejects immediately, without queueing, when the budget rejects outright', async () => {
    const { spawn } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 0 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const promise = pool.encodeWhenAdmitted(request());

    await expect(promise).rejects.toBeInstanceOf(DecodeJobNotAdmittedError);
    await expect(promise).rejects.toMatchObject({ reason: 'over-capacity' });
  });

  it('destroy() settles a still-queued waiter rather than leaving it hanging forever', async () => {
    const { spawn } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 1 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const first = pool.encode(request());
    if (first.verdict !== 'admitted') throw new Error('expected the first request to be admitted');
    const waiting = pool.encodeWhenAdmitted(request());

    const settlement = await settleWith(waiting);
    expect(settlement.state).toBe('pending'); // confirms destroy() is what settles it below, not something else

    pool.destroy();

    await expect(waiting).rejects.toThrow('WorkerPool destroyed');
    // `first` is still sitting unposted in `waiting` (never marked `ready`),
    // so `destroy()` abandons it too — awaited here so it doesn't surface as
    // an unhandled rejection from a promise this test otherwise never touches.
    await expect(first.pnts).rejects.toThrow('WorkerPool destroyed');
  });

  it('an abort while still queued rejects without ever touching the budget', async () => {
    const { spawn } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 1 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const first = pool.encode(request());
    if (first.verdict !== 'admitted') throw new Error('expected the first request to be admitted');

    const controller = new AbortController();
    const waiting = pool.encodeWhenAdmitted(request(), controller.signal);

    const before = budget.stats().decode.inUse;
    controller.abort();

    await expect(waiting).rejects.toBe(controller.signal.reason);
    // Still exactly the first request's own lease — the queued one never
    // called acquireDecodeJob at all.
    expect(budget.stats().decode.inUse).toBe(before);
  });

  it('a post() throw while retrying a waiter neither double-admits it nor orphans the next one', async () => {
    const port = new ThrowsOnSecondEncodePort();
    const budget = createBudget({ decodeJobs: 1 });
    const pool = createWorkerPool({ spawn: () => port, definition: DEFINITION, budget, size: 1 });

    // Occupies the pool's only decode-job lease. Its own encode message is
    // this port's first, which succeeds.
    const first = pool.encode(request());
    if (first.verdict !== 'admitted') throw new Error('expected the first request to be admitted');
    readyAll([port]);
    const firstEncode = encodeMessages(port)[0];
    if (firstEncode === undefined) throw new Error('expected the first encode message to have posted');

    // Both queue behind the lease `first` holds.
    const waitingA = pool.encodeWhenAdmitted(request());
    const waitingB = pool.encodeWhenAdmitted(request());
    expect((await settleWith(waitingA)).state).toBe('pending');
    expect((await settleWith(waitingB)).state).toBe('pending');

    // Releases `first`'s lease -> finish() -> admitWaiters() admits A, whose
    // dispatch() posts this port's SECOND encode message — the one that
    // throws. That throw re-enters admitWaiters() synchronously, from
    // inside this very reply.
    expect(() => port.reply({ kind: 'done', id: firstEncode.id, pnts: new ArrayBuffer(1) })).not.toThrow();

    // Exactly one lease outstanding — B's own. Two would mean A's request
    // was admitted a second time off the one lease `first` released.
    expect(budget.stats().decode.inUse).toBe(1);

    // A is not silently lost: its own admission attempt hit the throwing
    // port, and it settles — rejected with that failure — rather than
    // hanging or being resubmitted a second time.
    await expect(waitingA).rejects.toThrow('port broke on its second encode message');

    // B is not lost either. Before the fix, this promise was orphaned: a
    // positional shift() removed it from `deferredWaiters` without settling
    // it, so nothing — not even destroy() — could ever reach it again, and
    // it stayed pending forever. Here it must still be reachable: destroy()
    // settles it.
    expect((await settleWith(waitingB)).state).toBe('pending');
    pool.destroy();

    // Through settleWith rather than by awaiting: an orphaned B never
    // settles, and awaiting it makes this test fail as a five-second
    // timeout naming no state instead of a diff naming the one it is
    // stuck in.
    const afterDestroy = await settleWith(waitingB);
    expect(afterDestroy.state).toBe('rejected');
    if (afterDestroy.state !== 'rejected') throw new Error('unreachable');
    expect(afterDestroy.reason).toBeInstanceOf(Error);
    expect((afterDestroy.reason as Error).message).toContain('WorkerPool destroyed');
  });
});
