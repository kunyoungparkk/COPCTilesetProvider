import { describe, expect, it } from 'vitest';
import { formatRangeHeader, parseContentRange } from '../src/range/content-range.js';
import { InvalidByteRangeError } from '../src/errors/index.js';

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

describe('formatRangeHeader refusals', () => {
  // Left unguarded this emits `bytes=0--1`, which a server answers with a
  // confusing 416 rather than the real complaint.
  it('refuses a zero-length range', () => {
    expect(() => formatRangeHeader({ offset: 0, length: 0 })).toThrow(InvalidByteRangeError);
  });

  it('refuses a negative length', () => {
    expect(() => formatRangeHeader({ offset: 10, length: -1 })).toThrow(InvalidByteRangeError);
  });

  it('refuses a negative offset', () => {
    expect(() => formatRangeHeader({ offset: -1, length: 4 })).toThrow(InvalidByteRangeError);
  });
});

describe('parseContentRange bounds', () => {
  // Same doctrine as the `end < start` refusal: totalBytes is handed to callers
  // who do EOF arithmetic with it, so a header that contradicts itself is refused.
  it('refuses a range that ends past the total size', () => {
    expect(parseContentRange('bytes 0-3/2')).toBeNull();
  });

  it('accepts a range ending on the last byte', () => {
    expect(parseContentRange('bytes 0-1/2')?.end).toBe(1);
  });

  it('still accepts an undisclosed total', () => {
    expect(parseContentRange('bytes 0-3/*')?.totalBytes).toBeNull();
  });
});
