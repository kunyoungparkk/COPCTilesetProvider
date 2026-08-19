import { describe, expect, it, vi } from 'vitest';
import { createRangeReader } from '../src/range/index.js';

const FILE_URL = 'https://host/autzen.copc.laz';

/** A `fetch` stub that records its calls and replays canned responses. */
function stubFetch(...responses: Response[]) {
  const calls: { url: string; range: string | null }[] = [];
  const queue = [...responses];

  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), range: headers.get('range') });

    const next = queue.shift();
    if (next === undefined) {
      throw new Error('stub fetch ran out of responses');
    }
    return Promise.resolve(next);
  };

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
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

  it('reports an unreadable Content-Range as a server configuration problem', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), null));

    await expect(
      createRangeReader(FILE_URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'content-range-unreadable' });
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
    ['an unreadable Content-Range', () => partial(new ArrayBuffer(2), null)],
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
