import { describe, expect, it } from 'vitest';
import { createBudget } from '../src/budget/index.js';
import { settleWith } from './settled.js';
import { WorkerTaskFailedError, toWire } from '../src/errors/index.js';
import { createWorkerPool } from '../src/worker/pool.js';
import type { FromWorker, ToWorker, WorkerPort } from '../src/worker/protocol.js';
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

describe('createWorkerPool', () => {
  it('admits work on an idle port and resolves with the buffer the port replies with', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const req = request();
    const verdict = pool.encode(req);
    expect(verdict.verdict).toBe('admitted');
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');

    readyAll(ports);
    expect(totalEncodeMessages(ports)).toBe(1);

    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected some port to have received the encode message');
    const task = encodeMessages(port)[0];
    if (task === undefined) throw new Error('expected an encode message to have been posted');

    // The request's own header and pointCount ride along unchanged, and the
    // compressed buffer moves rather than clones (OVERVIEW §3 Decision 3):
    // exactly one transfer, and it is this request's own buffer.
    expect(task.header).toEqual(req.header);
    expect(task.pointCount).toBe(req.pointCount);
    const index = port.posted.indexOf(task);
    // `toBe`, not `toEqual`: two distinct ArrayBuffers holding identical bytes
    // are `toEqual`-equal, so value equality here would pass against a pool
    // that cloned the buffer instead of transferring it — which is the one
    // thing Decision 3 forbids. Identity is what says "moved".
    expect(port.transfers[index]).toHaveLength(1);
    expect(port.transfers[index]?.[0]).toBe(req.compressed);

    const pnts = new ArrayBuffer(8);
    port.reply({ kind: 'done', id: task.id, pnts });

    await expect(verdict.pnts).resolves.toBe(pnts);
  });

  it('spawns ports lazily: zero before the first encode, one right after it', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    expect(ports.length).toBe(0);
    pool.encode(request());
    expect(ports.length).toBe(1);
  });

  it('never posts more encode messages than the pool size, however many tasks are admitted', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 8 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 2 });

    for (let i = 0; i < 8; i++) {
      const verdict = pool.encode(request());
      expect(verdict.verdict).toBe('admitted');
    }
    // Only the init/ready handshake happens; no task is replied to.
    readyAll(ports);

    expect(totalEncodeMessages(ports)).toBe(2);
    expect(ports.length).toBe(2);
  });

  it('posts a waiting task as soon as a busy port frees up', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 8 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const first = pool.encode(request());
    const second = pool.encode(request());
    expect(first.verdict).toBe('admitted');
    expect(second.verdict).toBe('admitted');

    readyAll(ports);
    expect(totalEncodeMessages(ports)).toBe(1);

    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected some port to have received a task');
    const firstTask = encodeMessages(port)[0];
    if (firstTask === undefined) throw new Error('expected the first task to have been posted');
    port.reply({ kind: 'done', id: firstTask.id, pnts: new ArrayBuffer(4) });

    expect(totalEncodeMessages(ports)).toBe(2);
  });

  it('defers when the budget defers, posts nothing, and remembers nothing', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 1 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const first = pool.encode(request());
    expect(first.verdict).toBe('admitted');

    const second = pool.encode(request());
    expect(second).toEqual({ verdict: 'deferred' });

    readyAll(ports);
    expect(totalEncodeMessages(ports)).toBe(1);

    // Replying to the outstanding (first) task frees a decode-job slot, but
    // the deferred second request was never remembered, so nothing new is
    // posted as a result of this reply — on this port or any other.
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected some port to have received the first task');
    const firstTask = encodeMessages(port)[0];
    if (firstTask === undefined) throw new Error('expected the first task to have been posted');
    port.reply({ kind: 'done', id: firstTask.id, pnts: new ArrayBuffer(4) });

    expect(totalEncodeMessages(ports)).toBe(1);
  });

  it('rejects when the budget rejects, carrying the budget’s own reason', () => {
    const { spawn } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 0 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const verdict = pool.encode(request());
    expect(verdict).toEqual({ verdict: 'rejected', reason: 'over-capacity' });
  });

  it('rejects the promise with the rebuilt typed error on a failed reply', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const verdict = pool.encode(request());
    expect(verdict.verdict).toBe('admitted');
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');

    readyAll(ports);
    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected some port to have received the encode message');
    const task = encodeMessages(port)[0];
    if (task === undefined) throw new Error('expected an encode message to have been posted');

    const original = new Error('laz-perf choked on this chunk');
    port.reply({ kind: 'failed', id: task.id, error: toWire(original) });

    await expect(verdict.pnts).rejects.toBeInstanceOf(WorkerTaskFailedError);
    try {
      await verdict.pnts;
      throw new Error('expected verdict.pnts to reject');
    } catch (rejected) {
      expect(rejected).toBeInstanceOf(WorkerTaskFailedError);
      expect((rejected as WorkerTaskFailedError).code).toBe('worker-task-failed');
    }
  });

  it('sends init once per port, before any encode, and holds work until ready replies', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    pool.encode(request());

    // A single task never needs more than one port — pinned explicitly so
    // the rest of this test's use of `ports[0]` is not merely incidental.
    expect(ports.length).toBe(1);
    const port = ports[0];
    if (port === undefined) throw new Error('expected a port to have been spawned');
    expect(port.posted.length).toBe(1);
    const init = port.posted[0];
    if (init === undefined || init.kind !== 'init') throw new Error('expected an init message');
    expect(init.definition).toBe(DEFINITION);
    // Not yet ready: the encode task must not have been posted.
    expect(encodeMessages(port).length).toBe(0);

    port.reply({ kind: 'ready', id: init.id });

    expect(encodeMessages(port).length).toBe(1);
    // init still appears exactly once, ahead of the encode message it gated.
    expect(port.posted.filter((message) => message.kind === 'init').length).toBe(1);
    expect(port.posted[0]?.kind).toBe('init');
    expect(port.posted[1]?.kind).toBe('encode');
  });

  // The one hop that actually crosses the realm boundary: `definition` above
  // is asserted the same way, but only this assertion catches a `geoidHeight`
  // dropped from the posted `init` — the pool's own field, correctly typed
  // and correctly threaded everywhere else, simply never reaching `post()`.
  it('carries the geoid height on the init it posts', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({
      spawn,
      definition: DEFINITION,
      geoidHeight: -23.333,
      budget,
      size: 1,
    });

    pool.encode(request());

    const port = ports[0];
    if (port === undefined) throw new Error('expected a port to have been spawned');
    const init = port.posted[0];
    if (init === undefined || init.kind !== 'init') throw new Error('expected an init message');
    expect(init.geoidHeight).toBe(-23.333);
  });

  it('ignores a ready reply whose id does not match that port’s own init', () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    pool.encode(request());
    // One task, so exactly one port: pinned rather than assumed, so reading
    // `ports[0]` below stays correct if anyone changes what one encode does.
    expect(ports).toHaveLength(1);
    const port = ports[0];
    if (port === undefined) throw new Error('expected a port to have been spawned');
    const init = port.posted[0];
    if (init === undefined || init.kind !== 'init') throw new Error('expected an init message');

    // A `ready` carrying some other id — as if it were meant for a
    // different port's init, or corrupted — must not mark this slot ready.
    port.reply({ kind: 'ready', id: init.id + 1000 });
    expect(encodeMessages(port).length).toBe(0);

    // The real `ready`, with the matching id, still works.
    port.reply({ kind: 'ready', id: init.id });
    expect(encodeMessages(port).length).toBe(1);
  });

  it('never dispatches to a spawned port that has not yet replied ready', () => {
    // Two tasks, both admitted before either port has answered its `init`:
    // a slot that merely exists and is idle (not busy) must not be treated
    // as available until it has actually replied `ready`. Checking this
    // right after the second `encode()` call — before any reply at all —
    // is what distinguishes this from a check that only holds once a port
    // eventually becomes ready anyway.
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    pool.encode(request());
    pool.encode(request());

    expect(ports.length).toBe(2);
    for (const port of ports) {
      expect(encodeMessages(port).length).toBe(0);
    }

    // The over-spawn this test is really guarding against does not show up
    // until here: replying ready to only the first port re-enters dispatch()
    // while the second port still exists but is not ready. A third port
    // spawned at that point would be waste that nothing reclaims — one more
    // laz-perf WASM instantiation for the exact same two tasks. It must stay
    // at two: a slot that already exists and is merely not ready yet is
    // capacity already paid for, so a third task's worth of demand should
    // not spawn a third port when only two tasks were ever submitted.
    const first = ports[0];
    if (first === undefined) throw new Error('expected a port to have been spawned');
    const init = first.posted[0];
    if (init === undefined || init.kind !== 'init') throw new Error('expected an init message');
    first.reply({ kind: 'ready', id: init.id });

    expect(ports.length).toBe(2);
    expect(encodeMessages(first).length).toBe(1);
    const second = ports[1];
    if (second === undefined) throw new Error('expected a second port to have been spawned');
    expect(encodeMessages(second).length).toBe(0);
  });

  it('destroy() empties the waiting set, so a stale ready reply dispatches nothing', async () => {
    const { spawn, ports } = fakeSpawner();
    const budget = createBudget({ decodeJobs: 4 });
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const first = pool.encode(request());
    expect(first.verdict).toBe('admitted');
    if (first.verdict !== 'admitted') throw new Error('unreachable');
    pool.destroy();

    // The port spawned for that task now replies ready, as it normally
    // would. dispatch() itself carries no `destroyed` flag — destroy()
    // already emptied `waiting` before this reply arrives, and nothing can
    // refill it once destroyed, so dispatch()'s own loop condition is
    // already enough to send nothing here, on any port.
    readyAll(ports);
    expect(totalEncodeMessages(ports)).toBe(0);

    // destroy()'s own settling of outstanding tasks (OVERVIEW §3 Decision 5)
    // is exercised in full in worker-pool-lifecycle.test.ts; this test only
    // needs to know its own still-waiting task does not hang unattended.
    // Through settleWith rather than by awaiting: a destroy() that stopped
    // settling would otherwise fail this as a five-second timeout instead of
    // a diff naming the state it was left in.
    const settlement = await settleWith(first.pnts);
    expect(settlement.state).toBe('rejected');
    if (settlement.state !== 'rejected') throw new Error('unreachable');
    expect(settlement.reason).toBeInstanceOf(Error);
    expect((settlement.reason as Error).message).toContain('WorkerPool destroyed');

    const verdict = pool.encode(request());
    expect(verdict).toEqual({ verdict: 'rejected', reason: 'destroyed' });
  });
});

/** A `FakePort` whose `post` throws for `encode` messages (never for `init`), as a `SecurityError`-style `spawn` cannot: the port exists and is ready, but breaks on the next real message. */
class ThrowingEncodePort extends FakePort {
  override post(message: ToWorker, transfer: readonly ArrayBuffer[]): void {
    if (message.kind === 'encode') {
      throw new Error('ArrayBuffer is detached');
    }
    super.post(message, transfer);
  }
}

/** A `ThrowingEncodePort` that also aborts its own task's signal, synchronously, before throwing — what a third-party `WorkerPort` that re-enters the pool from inside `post` would produce. */
class AbortingEncodePort extends FakePort {
  private readonly controller: AbortController;

  constructor(controller: AbortController) {
    super();
    this.controller = controller;
  }

  override post(message: ToWorker, transfer: readonly ArrayBuffer[]): void {
    if (message.kind === 'encode') {
      this.controller.abort();
      throw new Error('port broke mid-post');
    }
    super.post(message, transfer);
  }
}

/** A `FakePort` whose `post` throws for the `init` message itself — a port that constructs but cannot be spoken to, which `spawn` throwing cannot reproduce because there no port ever exists. */
class ThrowingInitPort extends FakePort {
  override post(message: ToWorker, transfer: readonly ArrayBuffer[]): void {
    if (message.kind === 'init') {
      throw new Error('port refused the init message');
    }
    super.post(message, transfer);
  }
}

describe('createWorkerPool: spawn() and post() failures', () => {
  // The middle of the three call sites the spawn/post fix wraps. The other two
  // tests here cannot reach it: a throwing `spawn` fails before any port
  // exists, and a port that throws only on `encode` answers `init` fine.
  it('a port that throws on init is dropped, and its waiting task fails rather than waiting forever', async () => {
    const budget = createBudget({ decodeJobs: 4 });
    const ports: ThrowingInitPort[] = [];
    const spawn = (): WorkerPort => {
      const port = new ThrowingInitPort();
      ports.push(port);
      return port;
    };
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 1 });

    const verdict = pool.encode(request());
    if (verdict.verdict !== 'admitted') throw new Error('expected the request to be admitted');

    const settlement = await settleWith(verdict.pnts);
    expect(settlement.state).toBe('rejected');
    if (settlement.state !== 'rejected') throw new Error('unreachable');
    expect(settlement.reason).toBeInstanceOf(Error);
    expect((settlement.reason as Error).message).toContain('port refused the init message');

    // The lease came back, and the dead port was terminated rather than left
    // holding a Worker thread nobody can reach.
    expect(budget.stats().decode.inUse).toBe(0);
    expect(ports).toHaveLength(1);
    expect(ports[0]?.terminated).toBe(true);
  });

  it('a throwing spawn() fails every waiting task and releases every lease', async () => {
    const budget = createBudget({ decodeJobs: 4 });
    const spawn = (): WorkerPort => {
      throw new Error('worker-src CSP directive denied Worker creation');
    };
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const first = pool.encode(request());
    const second = pool.encode(request());
    if (first.verdict !== 'admitted' || second.verdict !== 'admitted') {
      throw new Error('expected both requests to be admitted');
    }

    const firstSettlement = await settleWith(first.pnts);
    const secondSettlement = await settleWith(second.pnts);
    if (firstSettlement.state !== 'rejected' || secondSettlement.state !== 'rejected') {
      throw new Error(`expected both to reject, got ${firstSettlement.state} and ${secondSettlement.state}`);
    }
    expect(firstSettlement.reason).toBeInstanceOf(Error);
    expect((firstSettlement.reason as Error).message).toContain('CSP');
    expect(budget.stats().decode.inUse).toBe(0);
  });

  it('a throwing post() on encode rejects the task, frees the slot, and releases the lease', async () => {
    const budget = createBudget({ decodeJobs: 4 });
    const ports: ThrowingEncodePort[] = [];
    const spawn = (): WorkerPort => {
      const port = new ThrowingEncodePort();
      ports.push(port);
      return port;
    };
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const verdict = pool.encode(request());
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');
    readyAll(ports); // re-enters dispatch(), which posts the encode message that throws

    const settlement = await settleWith(verdict.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    expect(settlement.reason).toBeInstanceOf(Error);
    expect((settlement.reason as Error).message).toContain('detached');
    expect(budget.stats().decode.inUse).toBe(0);

    // The slot is not left busy: it was dropped and terminated, not reused —
    // a later encode() has to spawn a fresh port.
    expect(ports).toHaveLength(1);
    expect(ports[0]?.terminated).toBe(true);
    const next = pool.encode(request());
    if (next.verdict !== 'admitted') throw new Error('unreachable');
    expect(ports).toHaveLength(2);
  });

  it('a post() that aborts its own task before throwing does not escape dispatch() or double-release the lease', async () => {
    const budget = createBudget({ decodeJobs: 4 });
    const controller = new AbortController();
    const ports: AbortingEncodePort[] = [];
    const spawn = (): WorkerPort => {
      const port = new AbortingEncodePort(controller);
      ports.push(port);
      return port;
    };
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 4 });

    const verdict = pool.encode(request(), controller.signal);
    if (verdict.verdict !== 'admitted') throw new Error('unreachable');

    // readyAll's reply() call is what re-enters dispatch() and posts the
    // encode message whose post() aborts the task, then throws. The abort
    // already released the lease and settled the promise by the time the
    // throw reaches dispatch()'s own catch — that catch must not release it
    // again, or the throw escapes here.
    expect(() => readyAll(ports)).not.toThrow();

    const settlement = await settleWith(verdict.pnts);
    if (settlement.state !== 'rejected') throw new Error(`expected a rejection, got ${settlement.state}`);
    expect(budget.stats().decode.inUse).toBe(0);
  });

  it('a spawn() failure while a sibling slot is healthy leaves the queued task waiting, not failed', async () => {
    const budget = createBudget({ decodeJobs: 4 });
    let spawnCount = 0;
    const ports: FakePort[] = [];
    const spawn = (): WorkerPort => {
      spawnCount++;
      if (spawnCount === 2) {
        throw new Error('worker-src CSP directive denied Worker creation');
      }
      const port = new FakePort();
      ports.push(port);
      return port;
    };
    const pool = createWorkerPool({ spawn, definition: DEFINITION, budget, size: 2 });

    const first = pool.encode(request());
    if (first.verdict !== 'admitted') throw new Error('unreachable');
    readyAll(ports); // the one healthy port becomes ready and takes `first`

    // Triggers the pool's second spawn attempt (its only free slot is busy),
    // which is the one that fails.
    const second = pool.encode(request());
    if (second.verdict !== 'admitted') throw new Error('unreachable');

    // The second spawn failed, but the first port is healthy and busy on
    // its own task right now — `second` must still be waiting for it, not
    // failed alongside a spawn attempt that says nothing about that port.
    const secondSettlement = await settleWith(second.pnts);
    expect(secondSettlement.state).toBe('pending');
    expect(budget.stats().decode.inUse).toBe(2); // both leases still held

    const port = busyPort(ports);
    if (port === undefined) throw new Error('expected the first task to have been posted');
    const firstTask = encodeMessages(port)[0];
    if (firstTask === undefined) throw new Error('expected the first task to have been posted');
    port.reply({ kind: 'done', id: firstTask.id, pnts: new ArrayBuffer(4) });

    // The healthy port frees up and takes the queued task itself — no
    // second port was ever created (its spawn failed), so this same port
    // now carries both.
    expect(ports).toHaveLength(1);
    expect(totalEncodeMessages(ports)).toBe(2);
    const stillPending = await settleWith(second.pnts);
    expect(stillPending.state).toBe('pending'); // posted, but not yet replied to
  });
});

describe('FakePort matches WorkerPort.onMessage/onError\'s adds-not-replaces contract', () => {
  // A guard against exactly the drift this pool once had: the real port
  // (`tests/worker-port-node.ts`, backed by `worker.on`) adds a listener per
  // call, and `tests/worker-entry.test.ts`'s `nextMessage` registers a fresh
  // one per awaited reply, relying on every earlier registration still
  // firing. A fake that instead kept only the latest handler would pass
  // every test in this file (the pool itself only ever registers once) while
  // silently disagreeing with the real port.
  it('onMessage adds handlers rather than replacing the previous one', () => {
    const port = new FakePort();
    const calls: FromWorker[] = [];
    port.onMessage((message) => calls.push(message));
    port.onMessage((message) => calls.push(message));

    port.reply({ kind: 'ready', id: 1 });

    expect(calls).toHaveLength(2);
  });

  it('onError adds handlers rather than replacing the previous one', () => {
    const port = new FakePort();
    const calls: Error[] = [];
    port.onError((error) => calls.push(error));
    port.onError((error) => calls.push(error));

    const raised = new Error('worker crashed');
    port.raiseError(raised);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(raised);
    expect(calls[1]).toBe(raised);
  });
});
