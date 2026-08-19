import { InvalidByteRangeError } from '../errors/index.js';

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

// Deliberately strict: only `bytes`, only a concrete start and end. Decision 4
// verifies every read against this header, so one we cannot fully understand has
// to be refused — the alternative is handing wrong offsets to a binary parser
// that will read them as corrupt data.
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Builds the `Range` request header for a read. */
export function formatRangeHeader(range: ByteRange): string {
  // A degenerate range emits something like `bytes=0--1`, which a server answers
  // with a 416 that hides the real complaint. A fractional length is worse still
  // once coalescing computes spans arithmetically on top of these numbers.
  const usable =
    Number.isInteger(range.offset) &&
    Number.isInteger(range.length) &&
    range.offset >= 0 &&
    range.length >= 1;
  if (!usable) {
    throw new InvalidByteRangeError(`length ${range.length} at offset ${range.offset}`);
  }

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
  const totalBytes = totalText === '*' ? null : Number(totalText);
  // Same reason as `end < start`: callers do EOF arithmetic with totalBytes, so
  // a header that contradicts its own total cannot be trusted for that.
  if (end < start || (totalBytes !== null && end >= totalBytes)) {
    return null;
  }

  return { start, end, totalBytes };
}
