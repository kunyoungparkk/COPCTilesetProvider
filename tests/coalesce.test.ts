import { describe, expect, it } from 'vitest';
import { InvalidByteRangeError } from '../src/errors/index.js';
import { planCoalescedReads } from '../src/range/coalesce.js';

describe('planCoalescedReads', () => {
  it('returns nothing for no requests', () => {
    expect(planCoalescedReads([])).toEqual([]);
  });

  it('leaves a lone range alone', () => {
    expect(planCoalescedReads([{ offset: 100, length: 50 }])).toEqual([
      { span: { offset: 100, length: 50 }, slices: [{ index: 0, offset: 0, length: 50 }] },
    ]);
  });

  it('merges adjacent ranges into one span with no waste', () => {
    const groups = planCoalescedReads([
      { offset: 0, length: 10 },
      { offset: 10, length: 10 },
    ]);

    expect(groups).toEqual([
      {
        span: { offset: 0, length: 20 },
        slices: [
          { index: 0, offset: 0, length: 10 },
          { index: 1, offset: 10, length: 10 },
        ],
      },
    ]);
  });

  it('merges across a small gap and reports the gap in the span', () => {
    // 8 wasted bytes in a 1000-byte span is 0.8%, inside the 2% cap.
    const groups = planCoalescedReads([
      { offset: 0, length: 500 },
      { offset: 508, length: 492 },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.span).toEqual({ offset: 0, length: 1000 });
    expect(groups[0]?.slices).toEqual([
      { index: 0, offset: 0, length: 500 },
      { index: 1, offset: 508, length: 492 },
    ]);
  });

  it('splits when the gap alone is too wide', () => {
    const groups = planCoalescedReads(
      [
        { offset: 0, length: 7_500_000 },
        { offset: 7_800_000, length: 7_500_000 },
      ],
      { maxGapBytes: 262_144 },
    );

    // The gap is 300 000 bytes over the threshold, but the span is 15 300 000 bytes
    // total, so the waste ratio is only 1.96% — below the cap. Only the gap clause
    // should cause the split. Both conditions must hold (Decision 4).
    expect(groups).toHaveLength(2);
  });

  it('splits when the gap is narrow but wastes too large a share', () => {
    // A 100-byte gap between two 100-byte reads is 33% of the merged span.
    const groups = planCoalescedReads([
      { offset: 0, length: 100 },
      { offset: 200, length: 100 },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.span).toEqual({ offset: 0, length: 100 });
    expect(groups[1]?.span).toEqual({ offset: 200, length: 100 });
  });

  it('closes a group when one more range would push it over the waste cap', () => {
    // Each 35-byte gap is individually under the 2% cap, but accumulated waste
    // over the span pushes it over. This catches implementations that check only
    // the latest gap instead of cumulative waste.
    const groups = planCoalescedReads(
      [
        { offset: 0, length: 1000 },
        { offset: 1035, length: 1000 },
        { offset: 2070, length: 1000 },
      ],
      { maxWasteRatio: 0.02 },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.slices.map((s) => s.index)).toEqual([0, 1]);
    expect(groups[1]?.slices.map((s) => s.index)).toEqual([2]);
  });

  it('sorts by offset while keeping each caller index', () => {
    const groups = planCoalescedReads([
      { offset: 10, length: 10 },
      { offset: 0, length: 10 },
    ]);

    expect(groups).toEqual([
      {
        span: { offset: 0, length: 20 },
        slices: [
          { index: 1, offset: 0, length: 10 },
          { index: 0, offset: 10, length: 10 },
        ],
      },
    ]);
  });

  // COPC chunks are disjoint, so these inputs mean the descriptor that produced
  // them is wrong. Merging them quietly would hide the bug.
  it('refuses overlapping ranges', () => {
    expect(() =>
      planCoalescedReads([
        { offset: 0, length: 10 },
        { offset: 5, length: 10 },
      ]),
    ).toThrow(InvalidByteRangeError);
  });

  it('refuses a zero-length range', () => {
    expect(() => planCoalescedReads([{ offset: 0, length: 0 }])).toThrow(InvalidByteRangeError);
  });

  // The pair that slips past every later check: their span is integral, so the
  // Range header and both response checks pass, and only the slicing at the end
  // notices — silently, by truncating.
  it('refuses fractional ranges that would sum to an integral span', () => {
    expect(() =>
      planCoalescedReads([
        { offset: 0, length: 10.5 },
        { offset: 10.5, length: 9.5 },
      ]),
    ).toThrow(InvalidByteRangeError);
  });

  // Pins the offset half of that guard, which the pair above never reaches:
  // the first range's fractional length throws before any offset is examined.
  it('refuses a fractional offset', () => {
    expect(() => planCoalescedReads([{ offset: 0.5, length: 10 }])).toThrow(InvalidByteRangeError);
  });
});
