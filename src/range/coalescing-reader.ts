import type { ByteRange } from './content-range.js';
import type { RangeRead, RangeReader } from './range-reader.js';

/** One `read` call waiting for the batch it joined to flush. */
interface PendingRead {
  readonly range: ByteRange;
  readonly signal: AbortSignal | undefined;
  readonly settle: (bytes: ArrayBuffer) => void;
  readonly fail: (error: unknown) => void;
}

/**
 * A signal that fires once every one of `signals` has aborted, or `undefined`
 * when the batch is not cancellable as a whole. Every listener it attaches is
 * pushed onto `detach`, for the caller to run once the batch has settled.
 *
 * This decides only when to stop the *transfer*, never when to answer a
 * caller — `flush` rejects each read the moment its own signal fires. A merged
 * response serves several tiles at once, so abandoning it while any one of
 * them still wants its slice would take bytes away from a tile Cesium is still
 * asking for. "Every member has given up" is the only moment that is safe.
 *
 * `undefined` when any member arrived without a signal: a member that can
 * never report giving up makes "every member has given up" unreachable, and a
 * signal that can never fire is worth less than none, which at least says so
 * in the type.
 */
function abortWhenAllAbort(
  signals: readonly (AbortSignal | undefined)[],
  detach: (() => void)[],
): AbortSignal | undefined {
  if (signals.some((signal) => signal === undefined)) {
    return undefined;
  }

  // Distinct instances, not members. Two reads can carry the same signal, and
  // `addEventListener` ignores a repeat registration of the same listener on
  // the same target — counting members would then leave `remaining` stuck
  // above zero and the request unabortable however many callers gave up.
  const distinct = new Set(signals as readonly AbortSignal[]);

  const controller = new AbortController();
  let remaining = distinct.size;
  const gaveUp = (): void => {
    remaining -= 1;
    if (remaining === 0) {
      controller.abort();
    }
  };
  for (const signal of distinct) {
    // None of these is aborted: `flush` drops an already-aborted read before
    // this runs, so such a signal is not in the batch to begin with.
    signal.addEventListener('abort', gaveUp, { once: true });
    detach.push(() => signal.removeEventListener('abort', gaveUp));
  }
  return controller.signal;
}

/**
 * Wraps a `RangeReader` so that reads issued in the same tick are merged into
 * as few requests as `planCoalescedReads` allows (OVERVIEW §3, Decision 4).
 *
 * Decision 4 permits merging "chunks of several nodes admitted at the same
 * moment", and this is what defines that moment. Cesium's traversal calls
 * `Cesium3DTile.requestContent` for every tile it selected in one synchronous
 * loop (`Cesium3DTileset.requestTiles`), so each of those calls reaches
 * `ScheduledRangeResource.fetchArrayBuffer` — and so this `read` — before
 * control returns to the event loop. Collecting them and flushing on a
 * microtask therefore captures exactly one frame's admitted requests, with no
 * timer to tune and no read held back for a batch that may never come: the
 * microtask runs before any I/O could have started anyway.
 *
 * Only `read` batches. `readMany` is already an explicit multi-range call, so
 * it goes straight through, as do `url` and `stats` — the counters a caller
 * reads through `stats()` are the wrapped reader's own, which is what keeps
 * §7's waste ratio measured against what actually reached the network.
 *
 * Batching decides how the reads are grouped and nothing else a caller can
 * observe. Each read is answered off its own group's promise the moment that
 * group's request lands, fails only on its own group's failure, and answers
 * its own signal as soon as that signal fires — so sharing a batch with a tile
 * that is slow, that timed out, or that Cesium is still waiting on costs a
 * caller nothing it would not have paid reading alone. What batching does
 * change is one report and one moment:
 *
 * - **`totalBytes` is always `null`.** The file's size travels in
 *   `Content-Range`, which `readMany` does not surface per slice. Nothing on
 *   this path reads it — `ScheduledRangeResource` destructures `bytes` alone,
 *   and `openCopc` takes the file's size from its own unbatched first read.
 * - **The transfer stops later than one caller's cancel.** A merged response
 *   serves several tiles, so it is abandoned only once every tile sharing it
 *   has given up — and, since the unit of that decision is the batch rather
 *   than the group, only once every tile in the batch has. A cancelled caller
 *   has already been answered by then; what continues is bytes nobody reads,
 *   bounded by what the budget admits in one frame (§7 caps concurrent
 *   requests per origin at 6).
 */
export function createCoalescingReader(reader: RangeReader): RangeReader {
  let pending: PendingRead[] = [];

  function flush(): void {
    // A read whose signal has already fired never reaches the network, and its
    // bytes are not asked for on anyone else's behalf either — the same as a
    // direct read, which checks before it counts a request
    // (`readOnce`'s own `throwIfAborted`).
    const batch = pending.filter((read) => {
      if (read.signal?.aborted !== true) {
        return true;
      }
      read.fail(read.signal.reason);
      return false;
    });
    pending = [];
    if (batch.length === 0) {
      return;
    }

    const detach: (() => void)[] = [];

    // Each read answers to its own signal, immediately, whatever happens to
    // the request it shares. This is the whole of what a caller sees of
    // cancellation, and it has to be prompt: `ScheduledRangeResource` releases
    // the tile's byte budget and its host slot (§7 allows six per origin) in
    // the `finally` of the read it is awaiting, so a cancelled tile that
    // stayed pending until the merged response landed would hold both for the
    // length of a transfer nobody was waiting on. The bytes still arrive for
    // whoever else the request serves; this caller has simply stopped
    // listening, and rejects with the same `signal.reason` a direct read
    // would have given it.
    for (const read of batch) {
      const signal = read.signal;
      if (signal === undefined) {
        continue;
      }
      const onAbort = (): void => read.fail(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      detach.push(() => signal.removeEventListener('abort', onAbort));
    }

    const ranges = batch.map((read) => read.range);
    const signal = abortWhenAllAbort(
      batch.map((read) => read.signal),
      detach,
    );

    const releaseListeners = (): void => {
      for (const off of detach) {
        off();
      }
      detach.length = 0;
    };

    // `readMany` plans synchronously, so nothing stops an implementation from
    // throwing here. Inside a `queueMicrotask` callback such a throw reaches
    // no caller at all — it surfaces as an unhandled error while every promise
    // in this batch stays pending forever. Catching it turns that into each
    // caller's own rejection.
    let answers: readonly Promise<ArrayBuffer>[];
    try {
      answers = reader.readMany(ranges, signal);
    } catch (thrown) {
      releaseListeners();
      for (const read of batch) {
        read.fail(thrown);
      }
      return;
    }

    // Each read is answered off its own promise, so it settles the moment its
    // own request does. Nothing here waits for the batch: a read whose bytes
    // arrived first is handed them first, and its budget and host slot go back
    // then rather than when the last of its neighbours finishes.
    batch.forEach((read, index) => {
      const answer = answers[index];
      if (answer === undefined) {
        // `readMany` promises one promise per request, in the caller's order.
        // Failing the read says so; leaving it unsettled would hang the tile
        // instead, with nothing naming the reader that broke the promise.
        read.fail(
          new Error(
            `range reader returned ${answers.length} answers for ${ranges.length} requests`,
          ),
        );
        return;
      }
      answer.then(read.settle, read.fail);
    });

    // The listeners outlive the individual reads — the shared abort is only
    // reached once every member has given up — so they come off when the last
    // request has settled, not the first.
    void Promise.allSettled(answers).then(releaseListeners);
  }

  return {
    url: reader.url,

    read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead> {
      return new Promise<RangeRead>((resolve, reject) => {
        // Scheduled on the first read of a batch only: every later read this
        // tick joins the flush already queued.
        if (pending.length === 0) {
          queueMicrotask(flush);
        }
        pending.push({
          range,
          signal,
          settle: (bytes) => resolve({ bytes, totalBytes: null }),
          fail: reject,
        });
      });
    },


    readMany: (requests, signal) => reader.readMany(requests, signal),

    stats: () => reader.stats(),
  };
}
