import { describe, expect, it, vi } from 'vitest';
import { createRangeReader } from '../src/range/index.js';
// Straight from the module, not from src/range/index.js: sleep is exported
// for this test alone and is not part of the package surface.
import { sleep } from '../src/range/range-reader.js';

const FILE_URL = 'https://host/autzen.copc.laz';

/** A `fetch` stub that records its calls and replays canned responses. */
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

function partial(body: ArrayBuffer, contentRange: string | null): Response {
  const headers = new Headers();
  if (contentRange !== null) {
    headers.set('content-range', contentRange);
  }
  return new Response(body, { status: 206, headers });
}

describe('createRangeReader', () => {
  it('sends the requested range and returns the bytes', async () => {
    const body = new Uint8Array([1, 2, 3, 4]).buffer;
    const { fetch, calls } = stubFetch(partial(body, 'bytes 0-3/1000'));

    const result = await createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 });

    expect(calls).toEqual([{ url: FILE_URL, range: 'bytes=0-3' }]);
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.totalBytes).toBe(1000);
  });

  // Decision 4: a 200 means the server ignored Range and is sending the whole
  // file. Accepting it would quietly turn streaming into a full download.
  it('refuses a 200 instead of falling back to it', async () => {
    const { fetch } = stubFetch(new Response(new ArrayBuffer(8), { status: 200 }));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-unsupported', status: 200 });
  });

  // Decision 4: a browser hides `Content-Range` from JavaScript unless the
  // server exposes it, and no public COPC dataset does — measured. So an
  // unreadable header is the ordinary cross-origin case, not a fault, and what
  // remains readable (the 206 and the body's length) is what the range is
  // verified against instead. The one thing that check cannot confirm is
  // *which* bytes came back.
  it('accepts a 206 whose Content-Range is unreadable when the length matches', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), null));

    const { bytes, totalBytes } = await createRangeReader(FILE_URL, { fetch }).read({
      offset: 0,
      length: 4,
    });

    expect(bytes.byteLength).toBe(4);
    // Nothing disclosed the file's size: the header that carries it is the one
    // that could not be read. `null` is the same answer a `bytes 0-3/*` gives.
    expect(totalBytes).toBeNull();
  });

  it('rejects an unreadable Content-Range when the length does not match', async () => {
    // The only check left once the header is gone, so a truncated body has to
    // fail here or nothing catches it.
    const { fetch } = stubFetch(partial(new ArrayBuffer(2), null));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'content-range-unreadable' });
  });

  it('still rejects a 200 when Content-Range is unreadable', async () => {
    // The relaxation is about *which* bytes, never about accepting the whole
    // file: a server that ignores Range answers 200, and that is still the
    // failure Decision 4 exists to prevent.
    const { fetch } = stubFetch(new Response(new ArrayBuffer(4), { status: 200 }));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-unsupported', status: 200 });
  });

  it('rejects a response for a different range', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), 'bytes 16-19/1000'));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({
      code: 'content-range-mismatch',
      expected: 'bytes=0-3',
      received: 'bytes 16-19/1000',
    });
  });

  // A header can agree while the body is short — a truncated proxy response.
  it('rejects a body shorter than the header promised', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(2), 'bytes 0-3/1000'));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'content-range-mismatch' });
  });

  it('reports a 404 as a request problem', async () => {
    const { fetch } = stubFetch(new Response(null, { status: 404 }));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-request-failed', status: 404 });
  });

  it('wraps a fetch rejection with CORS guidance', async () => {
    const fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch;

    await expect(
      createRangeReader(FILE_URL, { fetch, retryDelaysMs: [] }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-network' });
  });

  it('gives a large request proportionally more time', async () => {
    vi.useFakeTimers();
    try {
      // Never resolves, so only the deadline can end this request.
      const fetch = ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch;

      const oneMebibyte = 1024 * 1024;
      const pending = createRangeReader(FILE_URL, { fetch, retryDelaysMs: [] }).read({
        offset: 0,
        length: 4 * oneMebibyte,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'range-timeout',
        // 8s base plus 2s for each of four mebibytes.
        timeoutMs: 16_000,
      });

      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // Pins base and slope separately: 4 MiB -> 16_000 alone is also satisfied by
  // baseTimeoutMs: 0, timeoutMsPerMebibyte: 4_000, since 4 * 4_000 == 16_000.
  // A sub-mebibyte request only matches the real defaults (8_000 + 1 * 2_000).
  it('gives a 1-byte request the base timeout plus one rounded-up mebibyte', async () => {
    vi.useFakeTimers();
    try {
      // Never resolves, so only the deadline can end this request.
      const fetch = ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch;

      const pending = createRangeReader(FILE_URL, { fetch, retryDelaysMs: [] }).read({
        offset: 0,
        length: 1,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'range-timeout',
        // 8s base plus one partial mebibyte, rounded up, times 2s.
        timeoutMs: 10_000,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retry policy', () => {
  it('retries a 503 and returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      const body = new Uint8Array([9, 9]).buffer;
      const { fetch, calls } = stubFetch(
        new Response(null, { status: 503 }),
        partial(body, 'bytes 0-1/500'),
      );

      const pending = createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 2 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;

      expect(calls).toHaveLength(2);
      expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([9, 9]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the configured delays are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = stubFetch(
        new Response(null, { status: 500 }),
        new Response(null, { status: 500 }),
        new Response(null, { status: 500 }),
      );

      const pending = createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 2 });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'range-request-failed',
        status: 500,
      });

      await vi.advanceTimersByTimeAsync(2_500);
      await assertion;
      // Two delays means three attempts total, not three retries.
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // Decision 4: resending these returns the same answer, so retrying only
  // delays the error the caller needs to see.
  it.each([
    ['a 404', () => new Response(null, { status: 404 })],
    ['a 200', () => new Response(new ArrayBuffer(2), { status: 200 })],
    // One byte against the two asked for. An unreadable Content-Range is no
    // longer a failure on its own, so the case that must not be retried is the
    // length check failing with no header left to explain it.
    ['a short body with no Content-Range', () => partial(new ArrayBuffer(1), null)],
  ])('does not retry %s', async (_label, makeResponse) => {
    const { fetch, calls } = stubFetch(makeResponse());

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 2 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  // OVERVIEW §7 mandates timeouts and network errors be retried, and that a
  // retry gets its own deadline. Both earlier tests that touch range-timeout
  // and range-network opt out with retryDelaysMs: [], so without this test
  // neither guarantee is exercised anywhere in the suite.
  it('gives a retried attempt its own fresh deadline', async () => {
    vi.useFakeTimers();
    try {
      const body = new Uint8Array([9]).buffer;
      let callCount = 0;

      const fetch = ((_input: unknown, init?: RequestInit) => {
        callCount += 1;

        if (callCount === 1) {
          // Attempt 1: never resolves on its own — only its own deadline ends it.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }

        // Attempt 2 must carry its own, unexpired signal. If the deadline
        // controller were hoisted out of readOnce and shared across
        // attempts, this would be the same signal already aborted for
        // attempt 1, so it would read `aborted: true` here too.
        if (init?.signal?.aborted) {
          return Promise.reject(new Error('attempt 2 was given an already-aborted signal'));
        }
        return Promise.resolve(partial(body, 'bytes 0-0/10'));
      }) as unknown as typeof globalThis.fetch;

      const pending = createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 1 });
      const assertion = expect(pending).resolves.toMatchObject({ totalBytes: 10 });

      // Enough virtual time for either code path to fully settle: the fix
      // only needs attempt 1's 10s deadline plus its 500ms retry delay; a
      // surviving shared-controller mutation fails attempt 2 instantly on
      // the stale signal and needs its 2s retry delay on top of that.
      await vi.advanceTimersByTimeAsync(13_000);
      await assertion;

      const result = await pending;
      expect(callCount).toBe(2);
      expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([9]));
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The buffer `readMany` settled request `index` with, or a failure naming what
 * it settled with instead.
 *
 * `readMany` never rejects — a request's outcome is its own group's — so a
 * test that wants the bytes has to say so, and one that gets a rejection
 * instead should read why rather than `undefined is not a function`.
 */
function fulfilled(
  results: readonly PromiseSettledResult<ArrayBuffer>[],
  index: number,
): ArrayBuffer {
  const result = results[index];
  if (result?.status !== 'fulfilled') {
    throw new Error(`request ${index} did not settle with bytes: ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** The reason `readMany` settled request `index` with, or a failure if it succeeded. */
function rejection(
  results: readonly PromiseSettledResult<ArrayBuffer>[],
  index: number,
): unknown {
  const result = results[index];
  if (result?.status !== 'rejected') {
    throw new Error(`request ${index} was expected to fail, and did not`);
  }
  return result.reason;
}

describe('readMany', () => {
  it('reads neighbouring ranges in one request and splits the result', async () => {
    // Two 4-byte reads with a 2-byte gap: one 10-byte span. Based at file
    // offset 1000, not 0 — at 0, a bug that re-adds the span's file offset
    // to the already-span-relative slice.offset would be invisible, since
    // adding 0 changes nothing. Based away from 0, that bug slices out of
    // the 10-byte response buffer instead, which fails the checks below.
    const span = new Uint8Array([1, 2, 3, 4, 9, 9, 5, 6, 7, 8]).buffer;
    const { fetch, calls, overruns } = stubFetch(partial(span, 'bytes 1000-1009/100000'));

    // maxWasteRatio raised: at this fixture's byte counts, the 2-byte gap
    // alone is ~20% of the merged span, ten times the 2% production default
    // (OVERVIEW §7). That cap is coalesce.test.ts's job to pin; this test
    // only checks that a merged buffer gets sliced back apart correctly.
    const results = await createRangeReader(FILE_URL, { fetch, maxWasteRatio: 1 }).readMany([
      { offset: 1000, length: 4 },
      { offset: 1006, length: 4 },
    ]);

    expect(calls).toEqual([{ url: FILE_URL, range: 'bytes=1000-1009' }]);
    expect(overruns.count).toBe(0);
    expect(new Uint8Array(fulfilled(results, 0))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(fulfilled(results, 1))).toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  it('returns buffers in the caller order even when the file order differs', async () => {
    const span = new Uint8Array([1, 2, 3, 4]).buffer;
    const { fetch } = stubFetch(partial(span, 'bytes 0-3/1000'));

    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 2, length: 2 },
      { offset: 0, length: 2 },
    ]);

    expect(new Uint8Array(fulfilled(results, 0))).toEqual(new Uint8Array([3, 4]));
    expect(new Uint8Array(fulfilled(results, 1))).toEqual(new Uint8Array([1, 2]));
  });

  it('issues one request per group when ranges are too far apart', async () => {
    const { fetch, calls, overruns } = stubFetch(
      partial(new Uint8Array([1, 2]).buffer, 'bytes 0-1/9000000'),
      partial(new Uint8Array([3, 4]).buffer, 'bytes 8000000-8000001/9000000'),
    );

    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 0, length: 2 },
      { offset: 8_000_000, length: 2 },
    ]);

    expect(calls).toHaveLength(2);
    expect(overruns.count).toBe(0);
    expect(results).toHaveLength(2);
  });

  // maxGapBytes is a public option, so one fixture is read two ways: with an
  // override and without one. That pins end-to-end both that the option
  // reaches the planner and that passing none leaves the §7 default in place.
  // Each stub's canned responses only fit the plan its reader is supposed to
  // make, so a wrong plan fails verification on the request it should not have
  // sent.
  it('splits on maxGapBytes and merges again on the §7 default', async () => {
    // An 8-byte gap inside a 1000-byte span is 0.8% waste, well inside the 2%
    // cap, so the gap threshold alone decides how these two are read.
    const ranges = [
      { offset: 0, length: 500 },
      { offset: 508, length: 492 },
    ];

    const split = stubFetch(
      partial(new ArrayBuffer(500), 'bytes 0-499/100000'),
      partial(new ArrayBuffer(492), 'bytes 508-999/100000'),
    );
    await createRangeReader(FILE_URL, { fetch: split.fetch, maxGapBytes: 4 }).readMany(ranges);

    expect(split.calls.map((call) => call.range)).toEqual(['bytes=0-499', 'bytes=508-999']);
    expect(split.overruns.count).toBe(0);

    const merged = stubFetch(partial(new ArrayBuffer(1000), 'bytes 0-999/100000'));
    await createRangeReader(FILE_URL, { fetch: merged.fetch }).readMany(ranges);

    expect(merged.calls.map((call) => call.range)).toEqual(['bytes=0-999']);
    expect(merged.overruns.count).toBe(0);
  });

  it('reads nothing for an empty request list', async () => {
    const { fetch, calls, overruns } = stubFetch();

    expect(await createRangeReader(FILE_URL, { fetch }).readMany([])).toEqual([]);
    expect(calls).toEqual([]);
    expect(overruns.count).toBe(0);
  });

  // A merged span is verified exactly like any other read (Decision 4).
  it('fails both callers of a merged span whose Content-Range does not match', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(10), 'bytes 0-8/1000'));

    // Same relaxed cap as the first test, and for the same reason: without
    // it these two ranges land in separate groups, and the second group's
    // fetch call races an unrelated stub-exhaustion error instead of
    // exercising the merged-read verification this test is named for.
    const results = await createRangeReader(FILE_URL, {
      fetch,
      retryDelaysMs: [],
      maxWasteRatio: 1,
    }).readMany([
      { offset: 0, length: 4 },
      { offset: 6, length: 4 },
    ]);

    // One request served both, so both callers inherit its verdict — this is
    // the case where sharing a failure is right, and the test below is the
    // case where it is not.
    expect(rejection(results, 0)).toMatchObject({ code: 'content-range-mismatch' });
    expect(rejection(results, 1)).toMatchObject({ code: 'content-range-mismatch' });
  });

  // The reason readMany settles per request rather than rejecting as a whole.
  // A frame's reads routinely plan into more than one group — a hierarchy page
  // sits megabytes from any point chunk — and Cesium marks a failed tile
  // FAILED, a state `requestContent` never revisits. Reporting one group's
  // timeout as every group's failure would blank tiles whose own bytes were
  // already in hand, until the page was reloaded.
  it('fails only the group that failed, and still answers the group that did not', async () => {
    const { fetch, calls } = stubFetch(
      partial(new Uint8Array([1, 2]).buffer, 'bytes 0-1/9000000'),
      new Response(null, { status: 404 }),
    );

    // 8 MB apart, far outside the 256 KiB gap threshold (§7): two groups, two
    // requests, and the stub answers the first and refuses the second.
    const results = await createRangeReader(FILE_URL, { fetch, retryDelaysMs: [] }).readMany([
      { offset: 0, length: 2 },
      { offset: 8_000_000, length: 2 },
    ]);

    expect(calls).toHaveLength(2);
    expect(new Uint8Array(fulfilled(results, 0))).toEqual(new Uint8Array([1, 2]));
    expect(rejection(results, 1)).toMatchObject({ code: 'range-request-failed', status: 404 });
  });

  // Every tile read on a frame where nothing merged arrives as a group of one
  // covering its whole span, so a copy there is the common case rather than
  // the exception — a second allocation of the whole chunk, per tile, per
  // frame. The response body is this caller's already.
  it('hands a group of one its response buffer rather than a copy of it', async () => {
    const body = new Uint8Array([1, 2, 3, 4]).buffer;
    // Hand-built rather than a real `Response`, whose own `arrayBuffer()`
    // allocates: identity is the whole assertion, so the buffer this reader
    // is handed has to be one the test still holds.
    const fetch = (() =>
      Promise.resolve({
        status: 206,
        headers: new Headers({ 'content-range': 'bytes 0-3/1000' }),
        body: null,
        arrayBuffer: () => Promise.resolve(body),
      })) as unknown as typeof globalThis.fetch;

    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 0, length: 4 },
    ]);

    expect(fulfilled(results, 0)).toBe(body);
  });

  // The other half of the rule above: a merged response must be split into
  // buffers of its own, because each goes to a different tile and the codec
  // transfers it to a Worker — which detaches it, and would take its
  // neighbours' bytes with it if they were views on one buffer.
  it('gives each caller of a merged span a buffer of its own', async () => {
    const span = new Uint8Array([1, 2, 3, 4, 9, 9, 5, 6, 7, 8]).buffer;
    const { fetch } = stubFetch(partial(span, 'bytes 0-9/100000'));

    const results = await createRangeReader(FILE_URL, { fetch, maxWasteRatio: 1 }).readMany([
      { offset: 0, length: 4 },
      { offset: 6, length: 4 },
    ]);

    const first = fulfilled(results, 0);
    const second = fulfilled(results, 1);
    expect(first).not.toBe(second);
    expect(first.byteLength).toBe(4);
    expect(second.byteLength).toBe(4);
  });

  // planCoalescedReads refuses to plan ranges it cannot merge soundly — an
  // overlap, which in a COPC file means a hierarchy whose chunks disagree
  // about where a node's bytes are. That is a reason not to merge them, not a
  // reason to refuse to read them: unmerged they are ordinary requests, and
  // the defect surfaces where it did before merging existed, at decode.
  it('reads a batch the planner refuses one range at a time', async () => {
    const { fetch, calls } = stubFetch(
      partial(new Uint8Array([1, 2, 3, 4]).buffer, 'bytes 0-3/1000'),
      partial(new Uint8Array([3, 4]).buffer, 'bytes 2-3/1000'),
    );

    // The second range starts inside the first: planCoalescedReads throws
    // rather than producing slices that would hand two callers overlapping
    // bytes (`tests/coalesce.test.ts` pins that throw directly).
    const results = await createRangeReader(FILE_URL, { fetch }).readMany([
      { offset: 0, length: 4 },
      { offset: 2, length: 2 },
    ]);

    expect(calls.map((call) => call.range)).toEqual(['bytes=0-3', 'bytes=2-3']);
    expect(new Uint8Array(fulfilled(results, 0))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(new Uint8Array(fulfilled(results, 1))).toEqual(new Uint8Array([3, 4]));
    // Nothing was merged, so nothing was saved.
    expect(createRangeReader(FILE_URL, { fetch }).stats().requestsSaved).toBe(0);
  });
});

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
    // maxWasteRatio raised: the 2-byte gap between these ranges is 20% of
    // the merged 10-byte span, ten times the 2% production default
    // (OVERVIEW §7), so the default would split them into two requests.
    // This test exists to check the waste/saved counters on a merge, not
    // to pin the threshold — that's coalesce.test.ts's job.
    const reader = createRangeReader(FILE_URL, { fetch, maxWasteRatio: 1 });

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

  // Every counter reports what reached the network, so a merge planned and then
  // cancelled leaves no trace at all. The alternative — counting the plan —
  // makes bytesWasted / bytesRequested infinite here, which would argue for
  // merging less on evidence of nothing having been read.
  it('counts nothing for a readMany cancelled before it started', async () => {
    const { fetch, calls } = stubFetch();
    const controller = new AbortController();
    controller.abort();
    const reader = createRangeReader(FILE_URL, { fetch, maxWasteRatio: 1 });

    const results = await reader.readMany(
      [
        { offset: 0, length: 4 },
        { offset: 6, length: 4 },
      ],
      controller.signal,
    );
    expect(rejection(results, 0)).toMatchObject({ name: 'AbortError' });
    expect(rejection(results, 1)).toMatchObject({ name: 'AbortError' });

    expect(calls).toEqual([]);
    expect(reader.stats()).toEqual({
      requests: 0,
      retries: 0,
      bytesRequested: 0,
      bytesWasted: 0,
      requestsSaved: 0,
    });
  });

  // The gap bytes are paid for again on the retry, exactly as the server logs
  // them, so the §7 ratio stays the true share of the traffic.
  it('charges a retried merge for its gap bytes on both attempts', async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = stubFetch(
        new Response(null, { status: 503 }),
        partial(new ArrayBuffer(10), 'bytes 0-9/1000'),
      );
      // Same relaxed cap and the same reason as the merge tests above: at these
      // byte counts the 2-byte gap is 20% of the span, so the 2% production
      // default would split the pair instead of merging it.
      const reader = createRangeReader(FILE_URL, { fetch, maxWasteRatio: 1 });

      const pending = reader.readMany([
        { offset: 0, length: 4 },
        { offset: 6, length: 4 },
      ]);
      await vi.advanceTimersByTimeAsync(500);
      await pending;

      const stats = reader.stats();
      expect(stats).toEqual({
        requests: 2,
        retries: 1,
        bytesRequested: 20,
        bytesWasted: 4,
        requestsSaved: 1,
      });
      expect(stats.bytesWasted / stats.bytesRequested).toBeCloseTo(0.2);
    } finally {
      vi.useRealTimers();
    }
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

    // retryDelaysMs emptied: on the default schedule a misclassified
    // RangeTimeoutError is retryable, and sleep()'s own already-aborted
    // check would then reject with AbortError anyway — masking a deleted
    // guard instead of catching its removal. This test exists to pin the
    // catch block's classification on the first attempt alone.
    const pending = createRangeReader(FILE_URL, { fetch, retryDelaysMs: [] }).read(
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

      const reader = createRangeReader(FILE_URL, { fetch });
      const pending = reader.read({ offset: 0, length: 2 }, controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      // Far short of the 500 ms delay: the abort, not the clock, ends the wait.
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await assertion;

      expect(calls).toHaveLength(1);
      // The second attempt never went out, so the retry that would have made it
      // is not counted either — `retries` follows the same rule as `requests`.
      expect(reader.stats()).toMatchObject({ requests: 1, retries: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels every group of a readMany', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const aborted: string[] = [];
    const fetch = ((_input: unknown, init?: RequestInit) => {
      const requested = new Headers(init?.headers).get('range') ?? 'no range header';
      started.push(requested);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted.push(requested);
          reject(new Error('aborted'));
        });
      });
    }) as unknown as typeof globalThis.fetch;

    // 8 MB apart, far outside the 256 KiB gap threshold (§7), so these are two
    // groups issuing two requests — which the started list below also pins.
    const pending = createRangeReader(FILE_URL, { fetch }).readMany(
      [
        { offset: 0, length: 2 },
        { offset: 8_000_000, length: 2 },
      ],
      controller.signal,
    );
    controller.abort();
    const results = await pending;
    expect(rejection(results, 0)).toMatchObject({ name: 'AbortError' });
    expect(rejection(results, 1)).toMatchObject({ name: 'AbortError' });

    // Each group settles its own callers, so the results alone cannot tell a
    // cancelled sibling from an orphaned one left holding a connection open
    // forever. Comparing what started against what aborted can.
    expect(started).toEqual(['bytes=0-1', 'bytes=8000000-8000001']);
    expect([...aborted].sort()).toEqual([...started].sort());
  });

  it('still works with no signal at all', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), 'bytes 0-3/1000'));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).resolves.toMatchObject({ totalBytes: 1000 });
  });
});

// read() does reach sleep's already-aborted branch, but the window is one
// microtask wide: measured against read(), an abort queued a tick earlier is
// taken by readOnce's catch instead, and one tick later by sleep's own
// listener. Only microtask-precise scheduling drives it through read(), so the
// branch is pinned here directly — it is live code, not a defensive leftover.
describe('sleep', () => {
  it('rejects with the signal reason when the signal is already aborted', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new Error('cancelled before the wait began');
      controller.abort(reason);

      // The clock is never advanced: rejecting must not wait on the delay, and
      // nothing may be left scheduled to outlive the rejection. The timer count
      // is checked before awaiting, so a deleted guard fails this assertion
      // instead of hanging on a promise that will never settle; assigning the
      // assertion first attaches the rejection handler synchronously.
      const rejected = expect(sleep(2_000, controller.signal)).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves on the timer when there is no signal', async () => {
    vi.useFakeTimers();
    try {
      const waited = sleep(500);
      await vi.advanceTimersByTimeAsync(500);

      await expect(waited).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
