import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  CopcTilesetError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
} from '../errors/index.js';
import { planCoalescedReads, type CoalescedGroup } from './coalesce.js';
import { formatRangeHeader, parseContentRange, type ByteRange } from './content-range.js';

// Defaults come from OVERVIEW §7. Changing them requires a measurement and an
// update to that table.
const DEFAULT_BASE_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS_PER_MEBIBYTE = 2_000;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

// OVERVIEW §7: two retries, waiting 0.5s then 2s. The array length is the
// retry count — one delay per retry, so the two cannot drift apart.
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

/**
 * A delay a caller's abort can cut short, so a cancel is not stalled by a retry wait.
 *
 * Exported for tests only, and deliberately absent from `src/range/index.ts` so
 * the package surface is unchanged. Nothing outside this module should call it.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, ms);
      return;
    }
    // Sole guard for one window: an abort landing between readOnce's catch and
    // this call is already over by the time the listener below is attached, and
    // `abort` does not replay for a listener added after it fired.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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
  /** Largest gap between two ranges that may still be read as one. Defaults to 256 KiB (§7). */
  readonly maxGapBytes?: number;
  /** Largest share of a merged span that may be bytes nobody asked for. Defaults to 0.02 (§7). */
  readonly maxWasteRatio?: number;
}

export interface RangeRead {
  readonly bytes: ArrayBuffer;
  /** The file's total size when the server disclosed it. */
  readonly totalBytes: number | null;
}

/**
 * Cumulative counters for a reader's lifetime, snapshotted at the moment
 * `stats()` is called.
 *
 * §7 tunes the merge thresholds against measured request counts and waste,
 * so these figures have to be observable at any time rather than inferred
 * from logs. `bytesWasted / bytesRequested` is the ratio §7 is tuned
 * against — deliberately not stored as its own field, so there is one
 * source of truth and nothing that can go stale.
 *
 * Every field counts what reached the network, never what a plan proposed:
 * §7 re-measures against an observable Range server, and only counters drawn
 * from the same population as that server's log can be compared with it or
 * divided by each other.
 */
export interface RangeStats {
  /** HTTP requests issued, counting each retry separately. */
  readonly requests: number;
  /** Retry waits that ran to completion. */
  readonly retries: number;
  /** Bytes asked for across those requests, gap bytes included. */
  readonly bytesRequested: number;
  /**
   * Of those bytes, the ones no caller wanted — the price merging paid.
   * Per request like `bytesRequested`, so a retried merge pays its gap again.
   */
  readonly bytesWasted: number;
  /** Round trips merging removed, counted once the merged read has succeeded. */
  readonly requestsSaved: number;
}

export interface RangeReader {
  /** The file this reader reads. Errors name it, and a reader serves exactly one. */
  readonly url: string;
  read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead>;
  /**
   * Reads several ranges, merging neighbours into shared requests.
   *
   * One settled result per request, in the caller's order, whatever grouping
   * the planner chose. **Never rejects**: a request's outcome is its own
   * group's, and the grouping is this method's decision rather than the
   * caller's, so one group's failure must not be reported as every caller's.
   * A caller that wants all-or-nothing gets it by inspecting the results.
   */
  readMany(
    requests: readonly ByteRange[],
    signal?: AbortSignal,
  ): Promise<readonly PromiseSettledResult<ArrayBuffer>[]>;
  /** A snapshot of the counters accumulated since this reader was created. */
  stats(): RangeStats;
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

  // Built with a conditional spread rather than passed straight through:
  // exactOptionalPropertyTypes is on, so a `number | undefined` property is not
  // assignable to CoalesceOptions' optional `maxGapBytes?: number` — forwarding
  // options.maxGapBytes/maxWasteRatio directly does not compile. The planner's
  // own `??` fallbacks would supply the §7 defaults either way, so this is a
  // typechecker constraint, not a runtime one.
  const coalesceOptions = {
    ...(options.maxGapBytes !== undefined && { maxGapBytes: options.maxGapBytes }),
    ...(options.maxWasteRatio !== undefined && { maxWasteRatio: options.maxWasteRatio }),
  };

  // §7 tunes the merge thresholds against measured request counts and waste, so
  // those figures have to be observable at all times rather than inferred.
  const counters = {
    requests: 0,
    retries: 0,
    bytesRequested: 0,
    bytesWasted: 0,
    requestsSaved: 0,
  };

  // Coalescing (Decision 4) makes some requests much larger than others, so the
  // deadline grows with size. A flat timeout would kill exactly the big merged
  // reads that coalescing exists to create.
  function deadlineFor(range: ByteRange): number {
    return baseTimeoutMs + Math.ceil(range.length / BYTES_PER_MEBIBYTE) * timeoutMsPerMebibyte;
  }

  /**
   * One attempt at one span.
   *
   * `wantedBytes` is how much of the span some caller actually asked for; the
   * remainder is gap the merge paid for (Decision 4). It defaults to the whole
   * span, so an unmerged read reports no waste.
   */
  async function readOnce(
    range: ByteRange,
    signal?: AbortSignal,
    wantedBytes: number = range.length,
  ): Promise<RangeRead> {
    // Checked first, before the counters below: a read cancelled before it
    // reached the network must not appear in figures meant to match what a
    // server would log.
    signal?.throwIfAborted();

    const requested = formatRangeHeader(range);

    counters.requests += 1;
    counters.bytesRequested += range.length;
    // Counted here, beside the bytes it is a share of, rather than when the
    // merge was planned: §7 divides these two, which only means anything while
    // both count the same attempts.
    counters.bytesWasted += range.length - wantedBytes;

    const timeoutMs = deadlineFor(range);
    const controller = new AbortController();
    // Hand-rolled instead of AbortSignal.timeout: Vitest's fake timers patch
    // setTimeout, so vi.advanceTimersByTimeAsync can fast-forward this
    // deadline in tests. AbortSignal.timeout runs on a timer the fake clock
    // cannot reach, which would turn a millisecond test into a real sleep.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // The caller's own signal shares this fetch's controller, so an external
    // cancel ends the request the same way the deadline does. The catch
    // block below is what tells the two apart afterward.
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });

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

      // Absent rather than wrong, most often: cross-origin, a browser hands
      // JavaScript only the CORS-safelisted response headers, and
      // `Content-Range` is not among them unless the server names it in
      // `Access-Control-Expose-Headers`. Decision 4 accepts such a response on
      // what is still readable — the 206 above and the body's length below —
      // because no public COPC dataset exposes the header, and refusing meant
      // refusing all of them.
      const header = response.headers.get('content-range');
      const parsed = header === null ? null : parseContentRange(header);
      if (header !== null) {
        const lastByte = range.offset + range.length - 1;
        if (parsed === null || parsed.start !== range.offset || parsed.end !== lastByte) {
          void response.body?.cancel();
          throw new ContentRangeMismatchError(url, requested, header);
        }
      }

      // The deadline has to cover this read too: for a static byte range,
      // time-to-headers barely depends on size, so body transfer is the only
      // phase that actually scales with request length. OVERVIEW §7 sizes
      // timeoutMsPerMebibyte for exactly that phase — a term that protects
      // nothing if the clock stops before this line runs.
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== range.length) {
        // With the header, this says it agreed and the body did not — a
        // truncated or rewritten response. Without it, this *is* the whole
        // verification, so the same mismatch has to be reported as what it
        // leaves the caller unable to establish.
        throw header === null
          ? new ContentRangeUnreadableError(url, range.length, bytes.byteLength)
          : new ContentRangeMismatchError(
              url,
              `${requested} (${range.length} bytes)`,
              `${header} (${bytes.byteLength} bytes)`,
            );
      }

      // `null` when the header was unreadable: the file's size travels in it,
      // and nothing else in the response carries it. Callers already treat
      // this as optional — a server may answer `bytes 0-3/*` — and nothing in
      // the library reads it.
      return { bytes, totalBytes: parsed?.totalBytes ?? null };
    } catch (cause) {
      // The caller's abort also trips our deadline controller, so this has to
      // come first — otherwise a cancelled read is reported as a timeout.
      // This guards the attempt itself; sleep()'s already-aborted check guards
      // the way into the next one. Neither makes the other redundant.
      signal?.throwIfAborted();
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
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async function read(
    range: ByteRange,
    signal?: AbortSignal,
    wantedBytes: number = range.length,
  ): Promise<RangeRead> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readOnce(range, signal, wantedBytes);
      } catch (error) {
        const delayMs = retryDelaysMs[attempt];
        if (delayMs === undefined || !isWorthRetrying(error)) {
          throw error;
        }
        await sleep(delayMs, signal);
        // Counted after the wait, not before it: a cancel during the delay
        // means this retry never happened, and readOnce likewise counts only
        // attempts that reached the network.
        counters.retries += 1;
      }
    }
  }

  /**
   * One group per request, merging nothing — the plan for a batch the planner
   * would not plan.
   *
   * `planCoalescedReads` refuses input it cannot merge soundly: a range that
   * is not a whole number of bytes, and two ranges that overlap, which in a
   * COPC file means a hierarchy whose chunks disagree about where a node's
   * bytes are. That is a reason not to *merge* those ranges — merging them
   * would hand two callers wrong slices — and not a reason not to read them.
   * Read separately they are ordinary requests, each proving itself the usual
   * way, and each failing alone: a malformed range dies in
   * `formatRangeHeader` as its own caller's `InvalidByteRangeError`, and an
   * overlap surfaces where it did before merging existed, as a chunk that
   * fails to decode. Refusing the whole batch instead would take out every
   * unrelated tile that happened to be requested in the same frame.
   */
  function unmerged(requests: readonly ByteRange[]): readonly CoalescedGroup[] {
    return requests.map((range, index) => ({
      span: range,
      slices: [{ index, offset: 0, length: range.length }],
    }));
  }

  async function readMany(
    requests: readonly ByteRange[],
    signal?: AbortSignal,
  ): Promise<readonly PromiseSettledResult<ArrayBuffer>[]> {
    let groups: readonly CoalescedGroup[];
    try {
      groups = planCoalescedReads(requests, coalesceOptions);
    } catch {
      groups = unmerged(requests);
    }

    const results = new Array<PromiseSettledResult<ArrayBuffer>>(requests.length);

    // Groups run concurrently on purpose. Coalescing exists to remove round
    // trips, and serialising what is left would give the latency back. Bounding
    // how many run at once is admission control's job (Decision 5), and this
    // reader only ever sees ranges the budget already approved.
    await Promise.all(
      groups.map(async (group) => {
        const wantedBytes = group.slices.reduce((total, slice) => total + slice.length, 0);
        try {
          const { bytes } = await read(group.span, signal, wantedBytes);
          // Counted here rather than when the group was planned: a merge whose
          // request never went out, or never came back, saved no round trip.
          counters.requestsSaved += group.slices.length - 1;

          const only = group.slices.length === 1 ? group.slices[0] : undefined;
          if (only !== undefined && only.offset === 0 && only.length === bytes.byteLength) {
            // A group of one covering its whole span merged with nothing, and
            // this response holds exactly what its single caller asked for.
            // Slicing it would allocate and copy the chunk a second time for
            // no one — and every tile read on a frame where nothing merged
            // takes this path, so that copy would be the common case rather
            // than the exception. Handing the buffer over is safe because
            // nothing else holds it: it comes from this response alone, and
            // goes to one caller, which is free to transfer it to a Worker.
            results[only.index] = { status: 'fulfilled', value: bytes };
          } else {
            // A merged span, where each caller must get a buffer of its own:
            // they are handed to different tiles, and transferring one to a
            // Worker detaches it — which would take the others' bytes with it
            // if they were views on one buffer.
            for (const slice of group.slices) {
              results[slice.index] = {
                status: 'fulfilled',
                value: bytes.slice(slice.offset, slice.offset + slice.length),
              };
            }
          }
        } catch (reason: unknown) {
          // This group's callers, and nobody else's. A frame's reads routinely
          // plan into several groups — a hierarchy page sits megabytes from
          // any point chunk — so `Promise.all`'s all-or-nothing rejection
          // would report one request's timeout as every request's failure.
          // For a tile that costs everything: Cesium marks a failed tile
          // FAILED, which `requestContent` never revisits, so a tile whose own
          // bytes arrived would be blank until the page is reloaded.
          for (const slice of group.slices) {
            results[slice.index] = { status: 'rejected', reason };
          }
        }
      }),
    );

    return results;
  }

  function stats(): RangeStats {
    // A copy, so a caller holding an old snapshot sees the numbers as they were.
    return { ...counters };
  }

  return { url, read, readMany, stats };
}
