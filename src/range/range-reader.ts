import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
} from '../errors/index.js';
import { formatRangeHeader, parseContentRange, type ByteRange } from './content-range.js';

// Defaults come from OVERVIEW §7. Changing them requires a measurement and an
// update to that table.
const DEFAULT_BASE_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS_PER_MEBIBYTE = 2_000;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

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

export interface RangeReaderOptions {
  /** Injected for tests, which must never touch the network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Base request deadline in milliseconds. Defaults to 8000. */
  readonly baseTimeoutMs?: number;
  /** Additional deadline per mebibyte of request size in milliseconds. Defaults to 2000. */
  readonly timeoutMsPerMebibyte?: number;
  /**
   * Delay before each retry, in milliseconds. The array's length is the
   * retry count — there is no separate max-retries option. Defaults to
   * `[500, 2_000]` (OVERVIEW §7).
   */
  readonly retryDelaysMs?: readonly number[];
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
  const baseTimeoutMs = options.baseTimeoutMs ?? DEFAULT_BASE_TIMEOUT_MS;
  const timeoutMsPerMebibyte = options.timeoutMsPerMebibyte ?? DEFAULT_TIMEOUT_MS_PER_MEBIBYTE;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  // Coalescing (Decision 4) makes some requests much larger than others, so the
  // deadline grows with size. A flat timeout would kill exactly the big merged
  // reads that coalescing exists to create.
  function deadlineFor(range: ByteRange): number {
    return baseTimeoutMs + Math.ceil(range.length / BYTES_PER_MEBIBYTE) * timeoutMsPerMebibyte;
  }

  async function readOnce(range: ByteRange): Promise<RangeRead> {
    const requested = formatRangeHeader(range);

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
  }

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

  return { read };
}
