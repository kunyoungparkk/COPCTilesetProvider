/**
 * A `RangeReader` over bytes already in hand, for the modules that read a COPC
 * file without being about the transport.
 */
import type { ByteRange, RangeReader, RangeStats } from '../src/range/index.js';
import { FILE_URL } from './fixtures.js';

/** Every counter at zero: a reader serving a buffer measures nothing. */
export const NO_STATS: RangeStats = {
  requests: 0,
  retries: 0,
  bytesRequested: 0,
  bytesWasted: 0,
  requestsSaved: 0,
};

/** A `RangeReader` that also reports what was asked of it, in order. */
export interface RecordingReader extends RangeReader {
  readonly reads: ByteRange[];
}

export interface BufferReaderOptions {
  readonly url?: string;
  /** What `read` reports as the file's size. `null`, as a real 206 may leave it. */
  readonly totalBytes?: number | null;
  /**
   * The file offset `bytes` was cut from, so a caller can ask for the range
   * the real file holds these bytes at rather than for an offset into the
   * slice. Defaults to 0 — the buffer is the whole file as far as it knows.
   */
  readonly baseOffset?: number;
}

/**
 * Serves slices of one buffer, and records the ranges asked for.
 *
 * `readMany` rejects rather than being implemented: every caller here reads
 * one range at a time, and merging is `tests/range-reader.test.ts`'s subject
 * against a real reader. A test that reached it through this would be
 * measuring a fake.
 */
export function bufferReader(
  bytes: Uint8Array,
  options: BufferReaderOptions = {},
): RecordingReader {
  const baseOffset = options.baseOffset ?? 0;
  const totalBytes = options.totalBytes ?? null;
  const reads: ByteRange[] = [];

  return {
    url: options.url ?? FILE_URL,
    reads,
    read: (range: ByteRange) => {
      reads.push(range);
      const start = range.offset - baseOffset;
      return Promise.resolve({
        bytes: bytes.slice(start, start + range.length).buffer as ArrayBuffer,
        totalBytes,
      });
    },
    readMany: () => Promise.reject(new Error('this fake reader serves one range at a time')),
    stats: () => NO_STATS,
  };
}
