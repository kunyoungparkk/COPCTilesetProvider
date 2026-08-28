import { describe, expect, it, vi } from 'vitest';
import { createCoalescingReader } from '../src/range/coalescing-reader.js';
import { createRangeReader } from '../src/range/range-reader.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';
import { NO_STATS } from './fake-reader.js';
import { FILE_URL, fixtureFetch } from './fixtures.js';
import { settleWith } from './settled.js';

/**
 * `read` rejects by default rather than being left unimplemented: a wrapper
 * that quietly delegated `read` straight through — merging nothing — would
 * otherwise pass every test in this file.
 */
function fakeReader(overrides: Partial<RangeReader> = {}): RangeReader {
  return {
    url: FILE_URL,
    read: vi.fn(() => Promise.reject(new Error('a coalescing read must not reach reader.read'))),
    readMany: vi.fn(() => Promise.reject(new Error('unexpected readMany in this test'))),
    stats: vi.fn(() => ({ ...NO_STATS })),
    ...overrides,
  };
}

type Settled = readonly PromiseSettledResult<ArrayBuffer>[];

/** `readMany`'s answer for a request it served. */
const gave = (value: ArrayBuffer): PromiseSettledResult<ArrayBuffer> => ({
  status: 'fulfilled',
  value,
});

/** `readMany`'s answer for a request whose own group failed. */
const failed = (reason: unknown): PromiseSettledResult<ArrayBuffer> => ({
  status: 'rejected',
  reason,
});

/**
 * A `readMany` spy that never answers, so a test can inspect what was asked
 * before anything settles. Its parameters are declared rather than inferred:
 * `vi.fn(() => ...)` types its own `mock.calls` as an empty tuple, which makes
 * reading back the signal it was handed a type error.
 */
const capturingReadMany = (): ReturnType<
  typeof vi.fn<(requests: readonly ByteRange[], signal?: AbortSignal) => Promise<Settled>>
> =>
  vi.fn(
    (_requests: readonly ByteRange[], _signal?: AbortSignal) => new Promise<Settled>(() => {}),
  );

describe('reads issued in one tick', () => {
  it('reach the wrapped reader as a single readMany, in the order they were made', async () => {
    const first = new Uint8Array([1]).buffer;
    const second = new Uint8Array([2]).buffer;
    const readMany = vi.fn((_requests: readonly ByteRange[]) =>
      Promise.resolve([gave(first), gave(second)]),
    );
    const reader = createCoalescingReader(fakeReader({ readMany }));

    const a = reader.read({ offset: 0, length: 10 });
    const b = reader.read({ offset: 10, length: 20 });

    await expect(a).resolves.toEqual({ bytes: first, totalBytes: null });
    await expect(b).resolves.toEqual({ bytes: second, totalBytes: null });

    expect(readMany).toHaveBeenCalledTimes(1);
    expect(readMany.mock.calls[0]?.[0]).toEqual([
      { offset: 0, length: 10 },
      { offset: 10, length: 20 },
    ]);
  });

  it('are one batch per tick, not one batch forever', async () => {
    const readMany = vi.fn((requests: readonly ByteRange[]) =>
      Promise.resolve(requests.map(() => gave(new ArrayBuffer(1)))),
    );
    const reader = createCoalescingReader(fakeReader({ readMany }));

    await reader.read({ offset: 0, length: 10 });
    await reader.read({ offset: 10, length: 20 });

    // A wrapper that scheduled its flush once and never again would answer
    // the first read and leave the second pending forever; one that never
    // batched at all would make two calls here *and* two above.
    expect(readMany).toHaveBeenCalledTimes(2);
  });
});

describe('a batch that fails', () => {
  // The whole reason readMany settles per request. A batch plans into as many
  // groups as the gap thresholds require, and a tile whose own group came back
  // must not inherit a different group's timeout: Cesium marks a failed tile
  // FAILED, a state `requestContent` never revisits, so that tile would stay
  // blank until the page was reloaded.
  it('fails only the reads whose own group failed', async () => {
    const bytes = new Uint8Array([7]).buffer;
    const failure = new Error('the other group timed out');
    const reader = createCoalescingReader(
      fakeReader({
        readMany: vi.fn((_requests: readonly ByteRange[]) =>
          Promise.resolve([gave(bytes), failed(failure)]),
        ),
      }),
    );

    const served = reader.read({ offset: 0, length: 10 });
    const lost = reader.read({ offset: 8_000_000, length: 20 });

    await expect(served).resolves.toEqual({ bytes, totalBytes: null });
    await expect(lost).rejects.toBe(failure);
  });

  it('rejects every read when the reader rejects outright, naming nothing', async () => {
    const failure = new Error('the merged request failed');
    const reader = createCoalescingReader(
      fakeReader({ readMany: vi.fn(() => Promise.reject(failure)) }),
    );

    const a = reader.read({ offset: 0, length: 10 });
    const b = reader.read({ offset: 10, length: 20 });

    // `readMany` is documented never to reject, but it is an interface a
    // caller can implement. A rejection says nothing about which request
    // failed, so none of them can be reported as served.
    await expect(a).rejects.toBe(failure);
    await expect(b).rejects.toBe(failure);
  });

  // The flush runs inside `queueMicrotask`, where a synchronous throw reaches
  // no caller: it surfaces as an unhandled error and leaves every promise in
  // the batch pending for good. `settleWith` is what tells that apart from a
  // rejection — awaiting a promise that never settles is a test timeout with
  // no diff to read.
  it('rejects every read when readMany throws synchronously rather than rejecting', async () => {
    const failure = new Error('readMany threw synchronously');
    const reader = createCoalescingReader(
      fakeReader({
        readMany: vi.fn(() => {
          throw failure;
        }),
      }),
    );

    const a = reader.read({ offset: 0, length: 10 });
    const b = reader.read({ offset: 10, length: 20 });

    expect(await settleWith(a)).toEqual({ state: 'rejected', reason: failure });
    expect(await settleWith(b)).toEqual({ state: 'rejected', reason: failure });
  });

  it('fails a read the wrapped reader returned no result for, rather than leaving it pending', async () => {
    const reader = createCoalescingReader(
      // One result for two requests: a `RangeReader` breaking its own
      // one-result-per-request contract. Silently skipping the second would
      // hang that tile with nothing naming the cause.
      fakeReader({ readMany: vi.fn(() => Promise.resolve([gave(new ArrayBuffer(1))])) }),
    );

    const a = reader.read({ offset: 0, length: 10 });
    const b = reader.read({ offset: 10, length: 20 });

    expect(await settleWith(a)).toMatchObject({ state: 'fulfilled' });
    expect(await settleWith(b)).toMatchObject({
      state: 'rejected',
      reason: expect.objectContaining({ message: 'range reader returned 1 results for 2 requests' }),
    });
  });
});

describe('cancelling a merged request', () => {
  // The caller's half: a cancelled read is answered at once, whatever the
  // request it shares goes on to do. `ScheduledRangeResource` releases the
  // tile's byte budget and its host slot (§7 allows six per origin) in the
  // `finally` of the read it awaits, so a cancelled tile left pending until
  // the merged response landed would hold both for a transfer nobody was
  // waiting on — and §7's six would be spoken for by tiles already off screen.
  it('rejects a cancelled read at once, without waiting for the response', async () => {
    const readMany = capturingReadMany();
    const reader = createCoalescingReader(fakeReader({ readMany }));
    const cancelled = new AbortController();
    const wanted = new AbortController();

    const dropped = reader.read({ offset: 0, length: 10 }, cancelled.signal);
    const kept = reader.read({ offset: 10, length: 20 }, wanted.signal);
    await Promise.resolve();

    cancelled.abort();

    // The same reason a direct read rejects with (`readOnce`'s own
    // `throwIfAborted`), so nothing downstream can tell the two apart.
    expect(await settleWith(dropped)).toEqual({
      state: 'rejected',
      reason: cancelled.signal.reason,
    });
    // Its neighbour is untouched: `readMany` has not answered, and this read
    // is still waiting for the bytes it asked for.
    expect(await settleWith(kept)).toEqual({ state: 'pending' });
  });

  // The transfer's half, which is a different question from the caller's: one
  // response serves several tiles, so stopping it while any of them still
  // wants its slice would take bytes away from a tile Cesium is asking for.
  it('stops the transfer only once every member has given up', async () => {
    const readMany = capturingReadMany();
    const reader = createCoalescingReader(fakeReader({ readMany }));
    const one = new AbortController();
    const other = new AbortController();

    void reader.read({ offset: 0, length: 10 }, one.signal).catch(() => {});
    void reader.read({ offset: 10, length: 20 }, other.signal).catch(() => {});
    await Promise.resolve();

    const signal = readMany.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    one.abort();
    expect(signal?.aborted).toBe(false);

    other.abort();
    expect(signal?.aborted).toBe(true);
  });

  // Two reads can carry one signal — nothing in `RangeReader` says otherwise.
  // `addEventListener` ignores a repeat registration of the same listener on
  // the same target, so counting members rather than distinct signals would
  // leave the tally stuck above zero and this request unabortable however many
  // callers gave up.
  it('counts distinct signals, not members, when two reads share one', async () => {
    const readMany = capturingReadMany();
    const reader = createCoalescingReader(fakeReader({ readMany }));
    const shared = new AbortController();

    void reader.read({ offset: 0, length: 10 }, shared.signal).catch(() => {});
    void reader.read({ offset: 10, length: 20 }, shared.signal).catch(() => {});
    await Promise.resolve();

    shared.abort();

    expect(readMany.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it('asks for nothing at all when every read was cancelled before the flush', async () => {
    const readMany = capturingReadMany();
    const reader = createCoalescingReader(fakeReader({ readMany }));
    const one = new AbortController();
    const other = new AbortController();
    one.abort();
    other.abort();

    const first = reader.read({ offset: 0, length: 10 }, one.signal);
    const second = reader.read({ offset: 10, length: 20 }, other.signal);

    // No request is made for bytes nobody is waiting for — the same as a
    // direct read, which checks its signal before it counts a request.
    expect(await settleWith(first)).toEqual({ state: 'rejected', reason: one.signal.reason });
    expect(await settleWith(second)).toEqual({ state: 'rejected', reason: other.signal.reason });
    expect(readMany).not.toHaveBeenCalled();
  });

  // A batch where only some members were cancelled still has bytes to fetch,
  // and the cancelled ones must not be paid for: their ranges would widen the
  // merged span, or add a group of their own, for a caller already gone.
  it('leaves a cancelled read out of the request its neighbours still need', async () => {
    const readMany = capturingReadMany();
    const reader = createCoalescingReader(fakeReader({ readMany }));
    const gone = new AbortController();
    gone.abort();

    void reader.read({ offset: 0, length: 10 }, gone.signal).catch(() => {});
    void reader.read({ offset: 10, length: 20 }).catch(() => {});
    await Promise.resolve();

    expect(readMany.mock.calls[0]?.[0]).toEqual([{ offset: 10, length: 20 }]);
  });

  it('is not cancellable at all when a member arrived without a signal', async () => {
    const readMany = capturingReadMany();
    const reader = createCoalescingReader(fakeReader({ readMany }));
    const one = new AbortController();

    void reader.read({ offset: 0, length: 10 }, one.signal).catch(() => {});
    void reader.read({ offset: 10, length: 20 }).catch(() => {});
    await Promise.resolve();

    // The unsignalled read can never report giving up, so "everyone gave up"
    // is unreachable — passing a signal that could only ever stay unaborted
    // would claim a cancellability this batch does not have.
    expect(readMany.mock.calls[0]?.[1]).toBeUndefined();
    one.abort();
    expect(readMany.mock.calls[0]?.[1]).toBeUndefined();
  });
});

describe('what the wrapper does not change', () => {
  it('delegates url, stats and readMany to the reader it wraps', async () => {
    const stats = { ...NO_STATS, requests: 7, requestsSaved: 3 };
    const readMany = vi.fn(() => Promise.resolve([gave(new ArrayBuffer(1))]));
    const reader = createCoalescingReader(
      fakeReader({ stats: vi.fn(() => stats), readMany }),
    );

    expect(reader.url).toBe(FILE_URL);
    // §7 is retuned against these counters, so they have to stay the wrapped
    // reader's own — a wrapper keeping its own would report a merge's saved
    // round trips twice or not at all.
    expect(reader.stats()).toBe(stats);

    // An explicit multi-range call is already a batch; batching it again
    // would only delay it a microtask.
    await reader.readMany([{ offset: 0, length: 4 }]);
    expect(readMany).toHaveBeenCalledTimes(1);
  });
});

describe('through a real reader', () => {
  // The two chunks the pinned Autzen root page places first in the file, which
  // sit back to back with no gap at all (`fixtures/autzen-root-hierarchy.bin`,
  // keys 4-2-0-0 and 4-0-2-0). Adjacency is not a coincidence of this file:
  // COPC writes a node's points as one contiguous chunk, so siblings selected
  // in the same frame are what merging exists for.
  const FIRST = { offset: 1744, length: 192_613 };
  const SECOND = { offset: 194_357, length: 157_238 };

  it('turns two adjacent reads into one HTTP request, and still returns each its own bytes', async () => {
    // Synthetic bytes rather than the chunks themselves: each one carries its
    // own file offset mod 251, so a slice handed to the wrong caller — or cut
    // at the wrong place inside the merged response — is a value mismatch
    // rather than an equal-length pass. The real chunks would only prove the
    // lengths.
    const span = new Uint8Array(SECOND.offset + SECOND.length - FIRST.offset);
    for (let i = 0; i < span.length; i++) span[i] = (FIRST.offset + i) % 251;

    const { fetch, ranges: requested } = fixtureFetch([{ offset: FIRST.offset, bytes: span }]);
    const reader = createCoalescingReader(createRangeReader(FILE_URL, { fetch }));

    const [first, second] = await Promise.all([reader.read(FIRST), reader.read(SECOND)]);

    // One request spanning both, not two — the round trip Decision 4 exists
    // to remove.
    expect(requested).toEqual([`bytes=1744-${SECOND.offset + SECOND.length - 1}`]);

    expect(first.bytes.byteLength).toBe(FIRST.length);
    expect(second.bytes.byteLength).toBe(SECOND.length);
    expect(new Uint8Array(first.bytes)[0]).toBe(FIRST.offset % 251);
    expect(new Uint8Array(second.bytes)[0]).toBe(SECOND.offset % 251);

    // The gap is zero here, so merging cost nothing and saved one trip.
    expect(reader.stats()).toMatchObject({ requests: 1, requestsSaved: 1, bytesWasted: 0 });
  });
});
