# Verified Range Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the byte-range reader every other module reads through — one that proves each response is a real 206 for exactly the bytes asked for, and fails with an actionable error when it is not.

**Architecture:** A single `createRangeReader(url, options)` factory returning a `read(range)` function. `fetch` is injected so the whole module is testable offline. Verification is layered: HTTP status, then the `Content-Range` header, then the delivered byte count. Retry sits outside verification and only ever re-sends requests whose failure could plausibly differ next time.

**Tech Stack:** TypeScript 7 (browser ESM), Vitest, no runtime dependencies.

**Spec:** `OVERVIEW.md` — §3 Decision 4 (transport), §3 Decision 6 (errors are API), §7 (tuning knobs).

## Global Constraints

- Node 22 for all commands. This machine's default `node` is v18, so every command below assumes `export PATH=/home/kyp/.local/node22/bin:$PATH` first.
- No new runtime dependencies. OVERVIEW §5 fixes the set at `copc`, `laz-perf`, `proj4`; this module adds none. `tests/manifest.test.ts` fails the build if that changes.
- No 200 full-file fallback, ever (Decision 4). A 200 is an error, not a slower success path.
- No speculative prefetch. Every request's offset and length must come from something a previous response reported.
- Error messages are part of the public API (Decision 6): each names what failed and the exact change that fixes it.
- Comments explain *why*, and link non-obvious choices back to the OVERVIEW decision that forced them.
- Tests never touch the network. `fetch` is injected in every test.
- Commits: `type(scope): summary`, imperative, under 72 chars, body cites the decision.

## Roadmap — where this sits

Eight modules, ordered by what each one needs to already exist. Only sub-project 1 is planned in detail here; each later one gets its own plan.

| # | Module | Depends on | How it is verified |
|---|---|---|---|
| **1** | **`range` + `errors`** | — | **This plan.** Stub `fetch`, fake timers. Offline. |
| 2 | `range` coalescing | 1 | Stub `fetch` records the merged requests; assert request count and waste ratio against §7 knobs. |
| 3 | `crs` | `errors` | WKT fixtures → EPSG code; registered proj4 definition → 4326 → ECEF, compared to PDAL ground truth. |
| 4 | `copc` | 1 | Pinned byte-slice fixtures under `fixtures/`; header, info VLR, hierarchy pages → node descriptors. |
| 5 | `tileset` | 4 | Pure function: descriptors → synthetic 3D Tiles JSON. Snapshot the JSON; assert region containment and the ADD/geometricError rules. |
| 6 | `worker` | 3 | LAZ fixture → PNTS bytes, decoded back and compared field by field. |
| 7 | `budget` | — | Admission decisions as a pure state machine; assert every reservation is released exactly once on all four exit paths. |
| 8 | `cesium-runtime` | 5, 6, 7 | Extends the passing gate harness on `gate/codec-contract` into a real end-to-end Playwright run. |

The gate on branch `gate/codec-contract` already proved the module 8 coupling works, so nothing here is blocked on it.

**Deliberately not in this plan**, though both are Decision 4 concerns: request
coalescing is sub-project 2, and the per-host concurrency cap of 6 (§7) belongs
to admission control in `budget` (sub-project 7) — a reader that throttles
itself would compete with the budget rather than obey it.

## File Structure

- `src/errors/base.ts` — `CopcTilesetError`, the class every thrown error extends. One responsibility: give callers a stable `code` to branch on.
- `src/errors/range.ts` — the five transport errors. Each carries the fields a caller might branch on plus a message naming the fix.
- `src/errors/index.ts` — re-exports. The only path other modules import from.
- `src/range/content-range.ts` — pure string work: format a `Range` request header, parse and validate a `Content-Range` response header. No I/O, so it is trivially testable.
- `src/range/range-reader.ts` — the reader: one verified request, plus the retry policy around it.
- `src/range/index.ts` — re-exports `createRangeReader` and its types.
- `tests/errors.test.ts`, `tests/content-range.test.ts`, `tests/range-reader.test.ts` — flat, matching the existing `tests/` layout.

---

### Task 1: Typed errors

**Files:**
- Create: `src/errors/base.ts`, `src/errors/range.ts`, `src/errors/index.ts`
- Test: `tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CopcTilesetError` (abstract, `readonly code: string`); `RangeUnsupportedError(url, status)`, `RangeRequestFailedError(url, status)`, `RangeNetworkError(url, cause)`, `RangeTimeoutError(url, timeoutMs)`, `ContentRangeUnreadableError(url)`, `ContentRangeMismatchError(url, expected, received)`. Codes: `range-unsupported`, `range-request-failed`, `range-network`, `range-timeout`, `content-range-unreadable`, `content-range-mismatch`.

> **Why no parameter properties:** `tsconfig.json` sets `erasableSyntaxOnly`, so `constructor(readonly url: string)` will not compile. Declare fields, then assign in the constructor.

- [ ] **Step 1: Write the failing test**

```ts
// tests/errors.test.ts
import { describe, expect, it } from 'vitest';
import {
  ContentRangeUnreadableError,
  CopcTilesetError,
  RangeUnsupportedError,
} from '../src/errors/index.js';

// Decision 6 makes these messages API: a caller who reads one should know what
// to change without opening our source. These tests pin that promise.
describe('transport errors', () => {
  it('gives every error a stable code and the base type', () => {
    const error = new RangeUnsupportedError('https://host/a.copc.laz', 200);

    expect(error).toBeInstanceOf(CopcTilesetError);
    expect(error.code).toBe('range-unsupported');
    expect(error.name).toBe('RangeUnsupportedError');
    expect(error.status).toBe(200);
  });

  it('explains a 200 as a server capability problem, not a retryable blip', () => {
    const message = new RangeUnsupportedError('https://host/a.copc.laz', 200).message;

    expect(message).toContain('https://host/a.copc.laz');
    expect(message).toContain('206');
    expect(message).toContain('Accept-Ranges');
  });

  it('names the exact header a cross-origin server has to expose', () => {
    const message = new ContentRangeUnreadableError('https://cdn/a.copc.laz').message;

    expect(message).toContain('Access-Control-Expose-Headers: Content-Range');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors/index.js`.

- [ ] **Step 3: Write the base class**

```ts
// src/errors/base.ts

/**
 * The base class for every error this library throws.
 *
 * Errors are part of the public API (OVERVIEW §3, Decision 6), so they carry
 * two things: `code`, a stable identifier callers branch on, and a message
 * that names the change which fixes the problem. Messages may be reworded;
 * codes may not.
 */
export abstract class CopcTilesetError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Subclass name rather than "Error", so stack traces and logs identify
    // the failure without anyone having to read `code`.
    this.name = new.target.name;
  }
}
```

- [ ] **Step 4: Write the transport errors**

```ts
// src/errors/range.ts
import { CopcTilesetError } from './base.js';

/**
 * The server answered a Range request with a success status other than 206.
 *
 * Decision 4 rules out a 200 fallback: downloading the whole file would defeat
 * the one thing this library exists to do.
 */
export class RangeUnsupportedError extends CopcTilesetError {
  readonly code = 'range-unsupported';
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number) {
    super(
      `${url} answered a Range request with HTTP ${status} instead of 206 Partial Content. ` +
        'This library reads COPC files in pieces and never downloads them whole, so a ' +
        'server that ignores Range cannot be used. Host the file where byte ranges work ' +
        '(S3, nginx, or any static host that reports `Accept-Ranges: bytes`).',
    );
    this.url = url;
    this.status = status;
  }
}

/** The request itself was rejected — a 4xx or 5xx. */
export class RangeRequestFailedError extends CopcTilesetError {
  readonly code = 'range-request-failed';
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number) {
    super(
      `${url} returned HTTP ${status}. ` +
        (status >= 500
          ? 'The server reported a temporary failure and the request did not succeed within the configured retry budget.'
          : 'The request was rejected, so resending it would return the same answer. ' +
            'Check the URL, and whether the object requires credentials this library does not send.'),
    );
    this.url = url;
    this.status = status;
  }
}

/**
 * `fetch` rejected before any response arrived.
 *
 * In a browser the usual cause is CORS: a cross-origin file whose server does
 * not send `Access-Control-Allow-Origin` fails here, before status or headers
 * exist to inspect.
 */
export class RangeNetworkError extends CopcTilesetError {
  readonly code = 'range-network';
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `${url} could not be reached. If the file is on another origin, the server must send ` +
        '`Access-Control-Allow-Origin` for the browser to allow the request at all. ' +
        'Otherwise the host is unreachable or the URL is wrong.',
      { cause },
    );
    this.url = url;
  }
}

/** The request outlived its deadline. */
export class RangeTimeoutError extends CopcTilesetError {
  readonly code = 'range-timeout';
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(
      `${url} did not respond within ${timeoutMs}ms. The deadline scales with request ` +
        'size; a server this slow will not stream a point cloud usefully.',
    );
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A 206 arrived with no readable `Content-Range`.
 *
 * Decision 4 treats this as fatal rather than retryable: for a cross-origin
 * file the browser hides the header unless the server opts in, and nothing the
 * library does on a second attempt will change that.
 */
export class ContentRangeUnreadableError extends CopcTilesetError {
  readonly code = 'content-range-unreadable';
  readonly url: string;

  constructor(url: string) {
    super(
      `${url} returned 206 but its Content-Range header could not be read, so the ` +
        'response cannot be verified. For a cross-origin file the browser hides that ' +
        'header unless the server sends `Access-Control-Expose-Headers: Content-Range`. ' +
        'That is a server setting this library cannot work around, and retrying will ' +
        'not change it.',
    );
    this.url = url;
  }
}

/** The bytes that came back are not the bytes that were asked for. */
export class ContentRangeMismatchError extends CopcTilesetError {
  readonly code = 'content-range-mismatch';
  readonly url: string;
  readonly expected: string;
  readonly received: string;

  constructor(url: string, expected: string, received: string) {
    super(
      `${url} was asked for ${expected} but answered with ${received}. The library ` +
        'reads structure at exact offsets, so a shifted or truncated response would be ' +
        'parsed as corrupt data. Check for a proxy or CDN that rewrites range requests.',
    );
    this.url = url;
    this.expected = expected;
    this.received = received;
  }
}
```

```ts
// src/errors/index.ts
export { CopcTilesetError } from './base.js';
export {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
} from './range.js';
```

- [ ] **Step 5: Run the test and the typechecker**

Run: `npx vitest run tests/errors.test.ts && npm run typecheck`
Expected: PASS, and `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/errors tests/errors.test.ts
git commit -m "feat(errors): add typed transport errors"
```

---

### Task 2: Content-Range parsing

**Files:**
- Create: `src/range/content-range.ts`
- Test: `tests/content-range.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ByteRange { readonly offset: number; readonly length: number }`; `formatRangeHeader(range: ByteRange): string` returning `bytes=<first>-<last>`; `parseContentRange(header: string): ContentRange | null` where `interface ContentRange { readonly start: number; readonly end: number; readonly totalBytes: number | null }`. `null` means unparseable — the caller decides which error that is.

- [ ] **Step 1: Write the failing test**

```ts
// tests/content-range.test.ts
import { describe, expect, it } from 'vitest';
import { formatRangeHeader, parseContentRange } from '../src/range/content-range.js';

describe('formatRangeHeader', () => {
  it('converts offset and length into an inclusive byte range', () => {
    // Decision 4's first read: the COPC header plus the info VLR at offset 375.
    expect(formatRangeHeader({ offset: 0, length: 589 })).toBe('bytes=0-588');
  });

  it('formats a single byte', () => {
    expect(formatRangeHeader({ offset: 375, length: 1 })).toBe('bytes=375-375');
  });
});

describe('parseContentRange', () => {
  it('reads start, end, and total size', () => {
    expect(parseContentRange('bytes 0-588/1234567')).toEqual({
      start: 0,
      end: 588,
      totalBytes: 1234567,
    });
  });

  it('accepts an unknown total size', () => {
    expect(parseContentRange('bytes 0-588/*')).toEqual({
      start: 0,
      end: 588,
      totalBytes: null,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseContentRange('  bytes 10-19/20  ')?.start).toBe(10);
  });

  // Everything below is a header we must refuse rather than half-understand:
  // guessing here would hand corrupt offsets to the COPC parser.
  it.each([
    ['an unsatisfied range', 'bytes */1234567'],
    ['a unit other than bytes', 'items 0-588/1234567'],
    ['a missing total', 'bytes 0-588'],
    ['an end before the start', 'bytes 588-0/1234567'],
    ['nonsense', 'not a range at all'],
    ['an empty header', ''],
  ])('rejects %s', (_label, header) => {
    expect(parseContentRange(header)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/content-range.test.ts`
Expected: FAIL — cannot resolve `../src/range/content-range.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/range/content-range.ts

/** A half-open request for `length` bytes starting at `offset`. */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** A parsed `Content-Range` response header. `end` is inclusive, as HTTP defines it. */
export interface ContentRange {
  readonly start: number;
  readonly end: number;
  /** `null` when the server sent `*`, meaning it did not disclose the total. */
  readonly totalBytes: number | null;
}

// Deliberately strict: only `bytes`, only a concrete start and end. A header we
// cannot fully understand has to be refused, because the alternative is handing
// wrong offsets to a binary parser that will read them as corrupt data.
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Builds the `Range` request header for a read. */
export function formatRangeHeader(range: ByteRange): string {
  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}

/** Parses a `Content-Range` header, or returns `null` if it cannot be trusted. */
export function parseContentRange(header: string): ContentRange | null {
  const match = CONTENT_RANGE.exec(header.trim());
  if (match === null) {
    return null;
  }

  // `noUncheckedIndexedAccess` is on, so the groups are typed as possibly
  // undefined even though the pattern guarantees them.
  const [, startText, endText, totalText] = match;
  if (startText === undefined || endText === undefined || totalText === undefined) {
    return null;
  }

  const start = Number(startText);
  const end = Number(endText);
  if (end < start) {
    return null;
  }

  return { start, end, totalBytes: totalText === '*' ? null : Number(totalText) };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/content-range.test.ts && npm run typecheck`
Expected: PASS, `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/range/content-range.ts tests/content-range.test.ts
git commit -m "feat(range): parse and format byte-range headers"
```

---

### Task 3: One verified read

**Files:**
- Create: `src/range/range-reader.ts`, `src/range/index.ts`
- Test: `tests/range-reader.test.ts`

**Interfaces:**
- Consumes: Task 1's errors, Task 2's `ByteRange`, `formatRangeHeader`, `parseContentRange`.
- Produces: `createRangeReader(url: string, options?: RangeReaderOptions): RangeReader`, where `interface RangeReader { read(range: ByteRange): Promise<RangeRead> }` and `interface RangeRead { readonly bytes: ArrayBuffer; readonly totalBytes: number | null }`. `RangeReaderOptions` gains fields in Task 4 and Task 5; in this task it holds only `fetch?: typeof globalThis.fetch`.

> **Why inject `fetch`:** every test in this file must run offline (CLAUDE.md). Injection is also how Task 5 asserts *how many* requests were sent, which is the only way to prove the retry policy.

- [ ] **Step 1: Write the failing test**

```ts
// tests/range-reader.test.ts
import { describe, expect, it } from 'vitest';
import { createRangeReader } from '../src/range/index.js';

const URL = 'https://host/autzen.copc.laz';

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

    const result = await createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 });

    expect(calls).toEqual([{ url: URL, range: 'bytes=0-3' }]);
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.totalBytes).toBe(1000);
  });

  // Decision 4: a 200 means the server ignored Range and is sending the whole
  // file. Accepting it would quietly turn streaming into a full download.
  it('refuses a 200 instead of falling back to it', async () => {
    const { fetch } = stubFetch(new Response(new ArrayBuffer(8), { status: 200 }));

    await expect(
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-unsupported', status: 200 });
  });

  it('reports an unreadable Content-Range as a server configuration problem', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), null));

    await expect(
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'content-range-unreadable' });
  });

  it('rejects a response for a different range', async () => {
    const { fetch } = stubFetch(partial(new ArrayBuffer(4), 'bytes 16-19/1000'));

    await expect(
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 }),
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
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'content-range-mismatch' });
  });

  it('reports a 404 as a request problem', async () => {
    const { fetch } = stubFetch(new Response(null, { status: 404 }));

    await expect(
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-request-failed', status: 404 });
  });

  it('wraps a fetch rejection with CORS guidance', async () => {
    const fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch;

    await expect(
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 }),
    ).rejects.toMatchObject({ code: 'range-network' });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/range-reader.test.ts`
Expected: FAIL — cannot resolve `../src/range/index.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/range/range-reader.ts
import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeUnsupportedError,
} from '../errors/index.js';
import { formatRangeHeader, parseContentRange, type ByteRange } from './content-range.js';

export interface RangeReaderOptions {
  /** Injected for tests, which must never touch the network. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface RangeRead {
  readonly bytes: ArrayBuffer;
  /** The file's total size when the server disclosed it. */
  readonly totalBytes: number | null;
}

export interface RangeReader {
  read(range: ByteRange): Promise<RangeRead>;
}

/**
 * Creates a reader that proves every response before returning it.
 *
 * Verification runs in three layers, cheapest first: the status, then the
 * `Content-Range` header, then the number of bytes actually delivered. A
 * response that clears all three is the range that was asked for
 * (OVERVIEW §3, Decision 4).
 */
export function createRangeReader(url: string, options: RangeReaderOptions = {}): RangeReader {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function read(range: ByteRange): Promise<RangeRead> {
    const requested = formatRangeHeader(range);

    let response: Response;
    try {
      response = await doFetch(url, { headers: { range: requested } });
    } catch (cause) {
      throw new RangeNetworkError(url, cause);
    }

    if (response.status !== 206) {
      // Decision 4: a 200 is the whole file, which this library never accepts.
      if (response.status === 200) {
        throw new RangeUnsupportedError(url, 200);
      }
      if (response.status >= 400) {
        throw new RangeRequestFailedError(url, response.status);
      }
      throw new RangeUnsupportedError(url, response.status);
    }

    const header = response.headers.get('content-range');
    if (header === null) {
      throw new ContentRangeUnreadableError(url);
    }

    const parsed = parseContentRange(header);
    const lastByte = range.offset + range.length - 1;
    if (parsed === null || parsed.start !== range.offset || parsed.end !== lastByte) {
      throw new ContentRangeMismatchError(url, requested, header);
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== range.length) {
      // The header agreed but the body did not — a truncated or rewritten response.
      throw new ContentRangeMismatchError(
        url,
        `${requested} (${range.length} bytes)`,
        `${header} (${bytes.byteLength} bytes)`,
      );
    }

    return { bytes, totalBytes: parsed.totalBytes };
  }

  return { read };
}
```

```ts
// src/range/index.ts
export type { ByteRange } from './content-range.js';
export { createRangeReader } from './range-reader.js';
export type { RangeRead, RangeReader, RangeReaderOptions } from './range-reader.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, all files, `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/range tests/range-reader.test.ts
git commit -m "feat(range): verify every partial response before returning it"
```

---

### Task 4: Size-scaled timeouts

**Files:**
- Modify: `src/range/range-reader.ts`
- Test: `tests/range-reader.test.ts`

**Interfaces:**
- Consumes: Task 3's `createRangeReader`.
- Produces: `RangeReaderOptions` gains `baseTimeoutMs?: number` (default `8_000`) and `timeoutMsPerMebibyte?: number` (default `2_000`). Deadline is `baseTimeoutMs + ceil(length / 1_048_576) * timeoutMsPerMebibyte` (§7).

> **Why our own timer instead of `AbortSignal.timeout`:** Vitest's fake timers replace `setTimeout`, so a hand-rolled deadline can be advanced instantly in tests. `AbortSignal.timeout` uses a timer the fake clock does not control, which would make these tests sleep for real seconds.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/range-reader.test.ts — and add `vi` to the vitest import
it('gives a large request proportionally more time', async () => {
  vi.useFakeTimers();
  try {
    // Never resolves, so only the deadline can end this request.
    const fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof globalThis.fetch;

    const oneMebibyte = 1024 * 1024;
    const pending = createRangeReader(URL, { fetch }).read({ offset: 0, length: 4 * oneMebibyte });
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/range-reader.test.ts -t 'proportionally more time'`
Expected: FAIL — the read rejects as `range-network`, not `range-timeout`, because no deadline exists yet.

- [ ] **Step 3: Add the deadline**

In `src/range/range-reader.ts`, import `RangeTimeoutError` and `CopcTilesetError` alongside the other errors, extend the options, and make the deadline guard the fetch, the verification layers, and the body read together:

```ts
// Defaults come from OVERVIEW §7. Changing them requires a measurement and an
// update to that table.
const DEFAULT_BASE_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS_PER_MEBIBYTE = 2_000;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
```

```ts
export interface RangeReaderOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseTimeoutMs?: number;
  readonly timeoutMsPerMebibyte?: number;
}
```

Inside `createRangeReader`, before `read`:

```ts
  const baseTimeoutMs = options.baseTimeoutMs ?? DEFAULT_BASE_TIMEOUT_MS;
  const timeoutMsPerMebibyte = options.timeoutMsPerMebibyte ?? DEFAULT_TIMEOUT_MS_PER_MEBIBYTE;

  // Coalescing (Decision 4) makes some requests much larger than others, so the
  // deadline grows with size. A flat timeout would kill exactly the big merged
  // reads that coalescing exists to create.
  function deadlineFor(range: ByteRange): number {
    return baseTimeoutMs + Math.ceil(range.length / BYTES_PER_MEBIBYTE) * timeoutMsPerMebibyte;
  }
```

Replace everything in `read` after `const requested = formatRangeHeader(range);` with:

```ts
    const timeoutMs = deadlineFor(range);
    const controller = new AbortController();
    // Hand-rolled instead of AbortSignal.timeout: Vitest's fake timers patch
    // setTimeout, so vi.advanceTimersByTimeAsync can fast-forward this
    // deadline in tests. AbortSignal.timeout runs on a timer the fake clock
    // cannot reach, which would turn a millisecond test into a real sleep.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(url, {
        headers: { range: requested },
        signal: controller.signal,
      });

      if (response.status !== 206) {
        // Decision 4: a 200 is the whole file, which this library never accepts.
        if (response.status === 200) {
          void response.body?.cancel();
          throw new RangeUnsupportedError(url, 200);
        }
        if (response.status >= 400) {
          void response.body?.cancel();
          throw new RangeRequestFailedError(url, response.status);
        }
        void response.body?.cancel();
        throw new RangeUnsupportedError(url, response.status);
      }

      const header = response.headers.get('content-range');
      if (header === null) {
        void response.body?.cancel();
        throw new ContentRangeUnreadableError(url);
      }

      const parsed = parseContentRange(header);
      const lastByte = range.offset + range.length - 1;
      if (parsed === null || parsed.start !== range.offset || parsed.end !== lastByte) {
        void response.body?.cancel();
        throw new ContentRangeMismatchError(url, requested, header);
      }

      // The deadline has to cover this read too: for a static byte range,
      // time-to-headers barely depends on size, so body transfer is the only
      // phase that actually scales with request length. OVERVIEW §7 sizes
      // timeoutMsPerMebibyte for exactly that phase — a term that protects
      // nothing if the clock stops before this line runs.
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== range.length) {
        // The header agreed but the body did not — a truncated or rewritten response.
        throw new ContentRangeMismatchError(
          url,
          `${requested} (${range.length} bytes)`,
          `${header} (${bytes.byteLength} bytes)`,
        );
      }

      return { bytes, totalBytes: parsed.totalBytes };
    } catch (cause) {
      // The checks above throw our own typed errors; let those pass through
      // untouched instead of relabeling a verification failure as a
      // transport one.
      if (cause instanceof CopcTilesetError) {
        throw cause;
      }
      throw controller.signal.aborted
        ? new RangeTimeoutError(url, timeoutMs)
        : new RangeNetworkError(url, cause);
    } finally {
      clearTimeout(timer);
    }
```

> The deadline wraps the body read too, not just the wait for headers: for a
> static byte range, time-to-headers barely depends on size, so body transfer
> is the only phase that scales with request length, and OVERVIEW §7 sizes
> `timeoutMsPerMebibyte` for exactly that phase. A response verified as ours
> passes through untouched; anything else — including a stall mid-body — is
> classified as a timeout or network failure by the same controller. Each
> throw between headers and the body read also cancels the response body first
> (`void response.body?.cancel()`), so a rejected response releases its
> connection immediately instead of waiting for GC.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/range/range-reader.ts tests/range-reader.test.ts
git commit -m "feat(range): scale the request deadline with request size"
```

---

### Task 5: Retry policy

**Files:**
- Modify: `src/range/range-reader.ts`
- Test: `tests/range-reader.test.ts`

**Interfaces:**
- Consumes: Task 4's reader.
- Produces: `RangeReaderOptions` gains `retryDelaysMs?: readonly number[]` (default `[500, 2_000]`). The array's length *is* the retry count — there is no separate `maxRetries`. Retried: `range-timeout`, `range-network`, and `range-request-failed` with status ≥ 500. Never retried: 4xx, `range-unsupported`, and both `content-range-*` errors.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/range-reader.test.ts
describe('retry policy', () => {
  it('retries a 503 and returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      const body = new Uint8Array([9, 9]).buffer;
      const { fetch, calls } = stubFetch(
        new Response(null, { status: 503 }),
        partial(body, 'bytes 0-1/500'),
      );

      const pending = createRangeReader(URL, { fetch }).read({ offset: 0, length: 2 });
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

      const pending = createRangeReader(URL, { fetch }).read({ offset: 0, length: 2 });
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
      createRangeReader(URL, { fetch }).read({ offset: 0, length: 2 }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/range-reader.test.ts -t 'retry policy'`
Expected: FAIL — the 503 case rejects instead of retrying, and the stub reports one call where two are expected.

- [ ] **Step 3: Add the policy**

Add the default and the classifier at module scope in `src/range/range-reader.ts`:

```ts
// OVERVIEW §7: two retries, waiting 0.5s then 2s. The array length is the
// retry count — one delay per retry, so the two cannot drift apart.
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decides whether resending a request could produce a different answer.
 *
 * Decision 4 splits failures in two: transient ones (a timeout, a dropped
 * connection, a 5xx) are worth another attempt, while a rejected request or an
 * unverifiable response will answer identically forever. Retrying the second
 * kind only delays the error the caller needs to read.
 */
function isWorthRetrying(error: unknown): boolean {
  if (!(error instanceof CopcTilesetError)) {
    return false;
  }
  if (error.code === 'range-timeout' || error.code === 'range-network') {
    return true;
  }
  return error instanceof RangeRequestFailedError && error.status >= 500;
}
```

`CopcTilesetError` is already imported (Task 4's deadline needs it too, to let its own verification errors pass through). Add `readonly retryDelaysMs?: readonly number[]` to `RangeReaderOptions`, then rename the existing `read` to `readOnce` and wrap it:

```ts
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  async function read(range: ByteRange): Promise<RangeRead> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readOnce(range);
      } catch (error) {
        const delayMs = retryDelaysMs[attempt];
        if (delayMs === undefined || !isWorthRetrying(error)) {
          throw error;
        }
        await sleep(delayMs);
      }
    }
  }
```

> `retryDelaysMs[attempt]` returning `undefined` is what ends the loop, which is why `noUncheckedIndexedAccess` earns its keep here.

- [ ] **Step 4: Stop the two earlier tests from retrying**

Two tests written before this task now exercise the retry loop, because
`range-network` and `range-timeout` are both retryable. Left alone, the first
would sleep 2.5 real seconds and the second would hang waiting for delays its
fake clock never advances past. Both should assert the single-attempt
behaviour they were written for, so opt them out explicitly.

In `tests/range-reader.test.ts`, change the reader construction in
`'wraps a fetch rejection with CORS guidance'`:

```ts
      createRangeReader(URL, { fetch, retryDelaysMs: [] }).read({ offset: 0, length: 4 }),
```

and in `'gives a large request proportionally more time'`:

```ts
    const pending = createRangeReader(URL, { fetch, retryDelaysMs: [] }).read({
      offset: 0,
      length: 4 * oneMebibyte,
    });
```

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, and the run finishes in well under a second of wall clock —
a suite that suddenly takes seconds means a retry is sleeping on a real timer.

- [ ] **Step 6: Commit**

```bash
git add src/range/range-reader.ts tests/range-reader.test.ts
git commit -m "feat(range): retry only failures that could answer differently"
```

---

## Done when

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` passes, including the three pre-existing suites.
- [ ] `src/range/README.md` still describes what the module does; coalescing is named there and belongs to sub-project 2, so leave that sentence alone rather than deleting it.
- [ ] No new entry in `package.json` `dependencies`.
