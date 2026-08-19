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
