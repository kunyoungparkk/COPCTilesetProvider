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
