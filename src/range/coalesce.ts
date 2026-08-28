import { InvalidByteRangeError } from '../errors/index.js';
import type { ByteRange } from './content-range.js';

// OVERVIEW §7. A Range request costs a fixed round trip, so merging neighbours
// trades wasted bytes for saved latency — these two numbers say how much waste
// that trade is worth. Changing them requires a measurement against the
// observable Range server and an update to that table.
const DEFAULT_MAX_GAP_BYTES = 256 * 1024;
const DEFAULT_MAX_WASTE_RATIO = 0.02;
const DEFAULT_MAX_SPAN_BYTES = 4 * 1024 * 1024;

export interface CoalesceOptions {
  /** Largest gap between two ranges that may still be read as one. Defaults to 256 KiB. */
  readonly maxGapBytes?: number;
  /** Largest share of a merged span that may be bytes nobody asked for. Defaults to 0.02. */
  readonly maxWasteRatio?: number;
  /**
   * Largest request a merge may grow into. Defaults to 4 MiB (§7).
   *
   * The other two thresholds bound what merging *wastes*, and neither bounds
   * how large it gets: a COPC file writes its chunks back to back, so a run of
   * them merges with a gap of zero and a waste ratio of zero however long the
   * run is. What stops it is this, and nothing else — measured on the pinned
   * file, all 277 gaps between its chunks are zero, so the whole 81 MB point
   * region is one legal merge as far as gap and waste are concerned.
   *
   * A single range larger than this is still read: the limit refuses to *grow*
   * a span past it, so an oversized range simply forms a group of its own.
   */
  readonly maxSpanBytes?: number;
}

/** Where one caller's bytes sit inside the span that was actually read. */
export interface CoalescedSlice {
  /** Position of this range in the caller's original array. */
  readonly index: number;
  /** Offset of these bytes within the group's span, not within the file. */
  readonly offset: number;
  readonly length: number;
}

export interface CoalescedGroup {
  readonly span: ByteRange;
  readonly slices: readonly CoalescedSlice[];
}

/**
 * Groups byte ranges into the fewest spans worth reading.
 *
 * Decision 4 allows a merge only when both conditions hold: the gap between two
 * ranges is within `maxGapBytes`, and the bytes wasted across the whole merged
 * span stay within `maxWasteRatio` of it. The second is re-checked on every
 * addition, because a run of individually-cheap gaps can add up to an expensive
 * span — greedy merging that only looked at the newest gap would never notice.
 *
 * Pure arithmetic: it reads nothing and decides nothing about scheduling.
 */
export function planCoalescedReads(
  requests: readonly ByteRange[],
  options: CoalesceOptions = {},
): readonly CoalescedGroup[] {
  const maxGapBytes = options.maxGapBytes ?? DEFAULT_MAX_GAP_BYTES;
  const maxWasteRatio = options.maxWasteRatio ?? DEFAULT_MAX_WASTE_RATIO;
  const maxSpanBytes = options.maxSpanBytes ?? DEFAULT_MAX_SPAN_BYTES;

  const ordered = requests
    .map((range, index) => {
      // Integers as well as bounds, for the reason formatRangeHeader names:
      // two fractional ranges can sum to an integral span, which then passes
      // the Range header, the Content-Range check and the body-length check
      // alike, leaving ArrayBuffer.slice to truncate toward zero and hand two
      // callers overlapping, wrong-length buffers. Decision 6's doctrine —
      // what our own structure makes impossible fails loudly — applies here.
      if (
        !Number.isInteger(range.offset) ||
        !Number.isInteger(range.length) ||
        range.length < 1 ||
        range.offset < 0
      ) {
        throw new InvalidByteRangeError(
          `length ${range.length} at offset ${range.offset} (request ${index})`,
        );
      }
      return { index, offset: range.offset, length: range.length };
    })
    .sort((a, b) => a.offset - b.offset);

  const groups: CoalescedGroup[] = [];
  let start = 0;
  let end = 0; // exclusive
  let wanted = 0; // bytes some caller actually asked for
  let slices: CoalescedSlice[] = [];

  const flush = (): void => {
    if (slices.length > 0) {
      groups.push({ span: { offset: start, length: end - start }, slices });
    }
  };

  for (const range of ordered) {
    const rangeEnd = range.offset + range.length;

    if (slices.length === 0) {
      start = range.offset;
      end = rangeEnd;
      wanted = range.length;
      slices = [{ index: range.index, offset: 0, length: range.length }];
      continue;
    }

    if (range.offset < end) {
      // Disjoint chunks are a COPC invariant, so an overlap is a descriptor bug.
      throw new InvalidByteRangeError(
        `request ${range.index} at offset ${range.offset} overlaps the range ending at ${end}`,
      );
    }

    const mergedLength = rangeEnd - start;
    const mergedWaste = mergedLength - (wanted + range.length);
    const gap = range.offset - end;

    // Compared as a product rather than a ratio, so no division rounds a
    // borderline span the wrong way. The span limit joins them because neither
    // of the other two bounds size: back-to-back chunks merge at gap zero and
    // waste zero for as long as the run continues, which on a real COPC file
    // is the whole point region.
    if (gap > maxGapBytes || mergedWaste > mergedLength * maxWasteRatio || mergedLength > maxSpanBytes) {
      flush();
      start = range.offset;
      end = rangeEnd;
      wanted = range.length;
      slices = [{ index: range.index, offset: 0, length: range.length }];
      continue;
    }

    slices.push({ index: range.index, offset: range.offset - start, length: range.length });
    end = rangeEnd;
    wanted += range.length;
  }

  flush();
  return groups;
}
