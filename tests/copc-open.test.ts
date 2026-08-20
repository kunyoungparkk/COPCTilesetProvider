import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openCopc } from '../src/copc/index.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const SLICES: readonly { offset: number; bytes: Uint8Array }[] = [
  { offset: 0, bytes: load('autzen-head.bin') },
  { offset: 375, bytes: load('autzen-vlrs.bin') },
  { offset: 81_114_146, bytes: load('autzen-root-hierarchy.bin') },
];

/** Serves the pinned slices at their real file offsets, and refuses anything else. */
function autzenReader() {
  const reads: ByteRange[] = [];
  const reader: RangeReader = {
    url: 'https://host/autzen.copc.laz',
    read: (range) => {
      reads.push(range);
      const slice = SLICES.find(
        (candidate) =>
          range.offset >= candidate.offset &&
          range.offset + range.length <= candidate.offset + candidate.bytes.length,
      );
      if (slice === undefined) {
        throw new Error(`no fixture covers ${range.offset}+${range.length}`);
      }
      const start = range.offset - slice.offset;
      return Promise.resolve({
        bytes: slice.bytes.slice(start, start + range.length).buffer as ArrayBuffer,
        totalBytes: 81_123_042,
      });
    },
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
  return { reader, reads };
}

describe('openCopc', () => {
  it('opens the file in three requests and no more', async () => {
    const { reader, reads } = autzenReader();

    await openCopc(reader);

    // §4: metadata and root hierarchy, nothing else. Reads 2 and 3 are both
    // derived from what read 1 reported.
    expect(reads).toEqual([
      { offset: 0, length: 589 },
      { offset: 375, length: 1361 },
      { offset: 81_114_146, length: 8896 },
    ]);
  });

  it('surfaces everything the rest of the library needs', async () => {
    const { reader } = autzenReader();

    const file = await openCopc(reader);

    expect(file.header.pointCount).toBe(10_653_336);
    expect(file.info.cube).toHaveLength(6);
    expect(file.wkt?.startsWith('COMPD_CS[')).toBe(true);
    expect(file.totalBytes).toBe(81_123_042);
    expect(file.root.nodes).toHaveLength(278);
    expect(file.root.pages).toEqual([]);
  });

  it('stops at the first failure instead of reading on', async () => {
    const { reader, reads } = autzenReader();
    // Spreading a reader that already satisfies the interface needs no cast.
    const broken: RangeReader = {
      ...reader,
      read: (range) => {
        // Recorded before the throw below, so a second request is visible to
        // the assertion even though this reader refuses to serve it.
        reads.push(range);
        if (range.offset === 0) {
          const bytes = new Uint8Array(load('autzen-head.bin'));
          bytes.set(new TextEncoder().encode('JUNK'), 0);
          return Promise.resolve({ bytes: bytes.buffer as ArrayBuffer, totalBytes: null });
        }
        throw new Error('should not have read past the header');
      },
    };

    await expect(openCopc(broken)).rejects.toMatchObject({ code: 'not-copc' });
    // An implementation that read on and still reported the original error
    // would satisfy the line above; only this one shows it never tried.
    expect(reads).toEqual([{ offset: 0, length: 589 }]);
  });

  // Each of the three readers has this test for its own single read. The
  // signal has to survive every hop, and only a reader that sees all three
  // reads can say so.
  it('passes the abort signal to every read', async () => {
    const controller = new AbortController();
    const { reader } = autzenReader();
    const signals: (AbortSignal | undefined)[] = [];
    const watched: RangeReader = {
      ...reader,
      read: (range, signal) => {
        signals.push(signal);
        return reader.read(range, signal);
      },
    };

    await openCopc(watched, controller.signal);

    expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
  });
});
