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

// The gap and waste thresholds bound what a merge wastes; neither bounds how
// large it gets. A COPC file writes its chunks back to back — measured, all 277
// gaps in the pinned root page are zero — so a run of them merges at gap zero
// and waste zero for as long as the run continues. Without a span limit that
// run is the file's whole point region, and streaming becomes a download.
describe('the span limit', () => {
  /** Back-to-back ranges: no gap, no waste, so only size can stop the merge. */
  const contiguous = (count: number, each: number) =>
    Array.from({ length: count }, (_, index) => ({ offset: index * each, length: each }));

  it('stops a run of adjacent ranges from growing past it', () => {
    const groups = planCoalescedReads(contiguous(8, 1000), { maxSpanBytes: 2500 });

    // Two per group: a third would make the span 3000, past the limit.
    expect(groups.map((group) => group.span)).toEqual([
      { offset: 0, length: 2000 },
      { offset: 2000, length: 2000 },
      { offset: 4000, length: 2000 },
      { offset: 6000, length: 2000 },
    ]);
    expect(groups.flatMap((group) => group.slices.map((slice) => slice.index))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('merges the same run without a limit low enough to bite', () => {
    // Without this the test above would pass against a planner that never
    // merged adjacent ranges at all.
    const groups = planCoalescedReads(contiguous(8, 1000), { maxSpanBytes: 8000 });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.span).toEqual({ offset: 0, length: 8000 });
  });

  // The limit refuses to grow a span, not to read a range. A node bigger than
  // the limit still has to be fetched — it is one tile's own chunk.
  it('still reads a single range larger than the limit', () => {
    const groups = planCoalescedReads([{ offset: 0, length: 9000 }], { maxSpanBytes: 2500 });

    expect(groups).toEqual([
      { span: { offset: 0, length: 9000 }, slices: [{ index: 0, offset: 0, length: 9000 }] },
    ]);
  });

  // §7's own default, checked against the shape the pinned file actually has:
  // ~190 KB chunks written end to end.
  it('caps the default at 4 MiB, which is about twenty-two Autzen-sized chunks', () => {
    const groups = planCoalescedReads(contiguous(40, 190_000));

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.span.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
});
