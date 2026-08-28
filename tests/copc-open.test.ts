import { describe, expect, it } from 'vitest';
import { encodeHierarchyPage } from './hierarchy-page.js';
import { NO_STATS } from './fake-reader.js';
import { FILE_URL, fixtureBytes as load, TOTAL_BYTES } from './fixtures.js';
import { settleWith } from './settled.js';
import { openCopc } from '../src/copc/index.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const SLICES: readonly { offset: number; bytes: Uint8Array }[] = [
  { offset: 0, bytes: load('autzen-head.bin') },
  { offset: 375, bytes: load('autzen-vlrs.bin') },
  { offset: 81_114_146, bytes: load('autzen-root-hierarchy.bin') },
];

/**
 * Serves the pinned slices at their real file offsets, and refuses anything
 * else. Not `bufferReader`, which serves one buffer: `openCopc` reads three
 * ranges megabytes apart, and each has to come from its own slice.
 */
function autzenReader() {
  const reads: ByteRange[] = [];
  const reader: RangeReader = {
    url: FILE_URL,
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
        totalBytes: TOTAL_BYTES,
      });
    },
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => NO_STATS,
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

  // The COPC spec requires the hierarchy VLR to always consist of at least
  // one hierarchy page, and an empty octree already has an encoding (one
  // entry with pointCount 0) — so no conformant file needs this. Left
  // unrefused, it would reach readHierarchyPage's own zero-length early
  // return and open successfully with an empty root page, a blank globe with
  // nothing naming the file as the cause.
  it('refuses a root hierarchy page with a zero byte length', async () => {
    const { reader, reads } = autzenReader();
    const zeroed = new Uint8Array(load('autzen-head.bin'));
    // Offset 429 is where the info VLR's content starts (`INFO_VLR_HEADER_END`
    // in src/copc/header.ts); rootHierarchyPage.pageLength is the uint64 at
    // byte 48 of that content (copc.js's Info.parse), so 429 + 48 = 477.
    new DataView(zeroed.buffer).setBigUint64(429 + 48, 0n, true);
    const patched: RangeReader = {
      ...reader,
      read: (range, signal) => {
        if (range.offset === 0) {
          reads.push(range);
          return Promise.resolve({ bytes: zeroed.buffer as ArrayBuffer, totalBytes: 81_123_042 });
        }
        return reader.read(range, signal);
      },
    };

    const failure = openCopc(patched);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('root hierarchy page with a byte length of 0');
    // Nothing past the header is read at all. The refusal only needs the info
    // VLR, which read 1 already carried, so it is made before either of the
    // two reads that follow is issued — they now go out together, and gating
    // this on one of them would have cost a request to learn nothing.
    expect(reads).toEqual([{ offset: 0, length: 589 }]);
  });

  // The saving is a round trip on the one path `fromUrl` cannot return
  // without, so it is worth pinning as behaviour rather than leaving to a
  // reading of the source. Both dependent reads are held here: sequential code
  // could only ever have started the first of them.
  it('starts the VLR and hierarchy reads together, not one after the other', async () => {
    const { reader } = autzenReader();
    const started: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: RangeReader = {
      ...reader,
      read: async (range, signal) => {
        started.push(range.offset);
        // Read 1 answers immediately — the other two depend on it — while
        // both of its dependents are held until this test lets them go.
        if (range.offset !== 0) {
          await held;
        }
        return reader.read(range, signal);
      },
    };

    const opening = openCopc(gated);

    expect(await settleWith(opening)).toEqual({ state: 'pending' });
    expect(started).toEqual([0, 375, 81_114_146]);

    release();
    await expect(opening).resolves.toMatchObject({ totalBytes: 81_123_042 });
  });

  // The bound readHierarchyPage applies is only as good as the number this
  // function hands it, and passing the wrong one is invisible from inside
  // that function: it would still refuse something, just never the entries
  // that matter. So this serves the real header and VLRs — the header says
  // 10,653,336 points — with a root page whose first entry claims one more,
  // and pins that opening the file fails. Mutating `header.pointCount` here
  // to any larger constant reddens this and nothing else.
  it('bounds the hierarchy by the point count its own header reported', async () => {
    const entry = encodeHierarchyPage([
      { key: [1, 0, 0, 0], offset: 4096, byteSize: 512, pointCount: 10_653_337 },
    ]);
    // The info VLR fixes the root page at 8896 bytes, so the constructed page
    // has to be that long. Trailing zeros parse as one empty node keyed
    // 0-0-0-0, which is legal — hence the 1-0-0-0 key above, so the entry
    // under test is not the one those zeros collapse into.
    const page = new Uint8Array(8896);
    page.set(entry, 0);
    const { reader } = autzenReader();
    const served: RangeReader = {
      ...reader,
      read: (range, signal) =>
        range.offset === 81_114_146
          ? Promise.resolve({ bytes: page.buffer.slice(0) as ArrayBuffer, totalBytes: 81_123_042 })
          : reader.read(range, signal),
    };

    const failure = openCopc(served);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('10653337');
    await expect(failure).rejects.toThrow('10653336');
  });

  // COPC allows point data record formats 6, 7 and 8, and all three open.
  // Anything else is not a COPC file: copc.js's extractor has no branch for
  // it and throws an untyped error the first time a Worker decodes a chunk —
  // per tile, after the globe has loaded. Refusing at open names the file and
  // the format once instead.
  describe('point data record format', () => {
    // Byte 104 packs the format in its low nibble and LAZ's compression flag
    // in the high bit (`node_modules/copc/lib/las/header.js`: `dv.getUint8(104)
    // & 0b1111`). Autzen's raw byte is 135 (0b10000111): masking in a new
    // format without preserving the high bits would also clear the
    // compression flag, failing the file for an unrelated reason.
    const patchPointFormat = (format: number): Uint8Array => {
      const bytes = new Uint8Array(load('autzen-head.bin'));
      bytes[104] = (bytes[104]! & 0b1111_0000) | format;
      return bytes;
    };

    const withPatchedHead = (
      reader: RangeReader,
      reads: ByteRange[],
      patched: Uint8Array,
    ): RangeReader => ({
      ...reader,
      read: (range, signal) => {
        if (range.offset === 0) {
          reads.push(range);
          return Promise.resolve({ bytes: patched.buffer as ArrayBuffer, totalBytes: 81_123_042 });
        }
        return reader.read(range, signal);
      },
    });

    it('refuses a format COPC does not allow', async () => {
      const { reader, reads } = autzenReader();
      // 3 is a real LAS format (colour and GPS time, legacy point record) and
      // a valid choice for a plain LAZ file — it is only COPC that excludes
      // it. Chosen over a nonsense number for that reason: it is the mistake
      // someone actually makes, by pointing this library at a LAZ file that
      // was never COPC.
      const withFormat3 = withPatchedHead(reader, reads, patchPointFormat(3));

      const failure = openCopc(withFormat3);

      await expect(failure).rejects.toMatchObject({
        code: 'unsupported-point-format',
        pointDataRecordFormat: 3,
      });
      await expect(failure).rejects.toThrow('https://host/autzen.copc.laz');
      await expect(failure).rejects.toThrow('3');
    });

    // One case per accepted format, so the check cannot degenerate into an
    // allow-list of whichever one the fixture happens to be.
    it.each([6, 7, 8])('opens format %i, which COPC allows', async (format) => {
      const { reader, reads } = autzenReader();
      // Autzen is already format 7; 6 and 8 are patched in. Only the format
      // byte changes, so neither is a real record of its format — a genuine
      // format-6 point is 30 bytes and a format-8 one 38, against the 36 this
      // header still declares. `openCopc` never reads a point body, so the
      // inconsistency is invisible to what is under test, and what this pins
      // is exactly one thing: each format is on the accepted side of the
      // check. Whether a colourless file then *encodes* is
      // `tests/worker-pnts.test.ts`'s question, not this one's.
      const patched = withPatchedHead(reader, reads, patchPointFormat(format));

      const file = await openCopc(patched);

      expect(file.header.pointDataRecordFormat).toBe(format);
    });

    it('refuses before the hierarchy page is read', async () => {
      const { reader, reads } = autzenReader();
      const withFormat3 = withPatchedHead(reader, reads, patchPointFormat(3));

      await expect(openCopc(withFormat3)).rejects.toMatchObject({
        code: 'unsupported-point-format',
      });
      // Only the header/info read happened — no read for the WKT VLR region
      // or the root hierarchy page, because the refusal is at open, not at
      // the first tile a Worker would later fail to decode.
      expect(reads).toEqual([{ offset: 0, length: 589 }]);
    });
  });

  // Each of the three readers has this test for its own single read. The
  // signal has to survive every hop, and only a reader that sees all three
  // reads can say so.
  it('gives every read a signal, and lets the caller abort all three', async () => {
    const controller = new AbortController();
    const { reader } = autzenReader();
    const seen: (AbortSignal | undefined)[] = [];
    const watched: RangeReader = {
      ...reader,
      read: async (range, signal) => {
        seen.push(signal);
        if (range.offset === 0) {
          return reader.read(range, signal);
        }
        // Reads 2 and 3 stay in flight, so the caller's abort has something
        // to reach.
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return reader.read(range, signal);
      },
    };

    const opening = openCopc(watched, controller.signal);
    expect(await settleWith(opening)).toEqual({ state: 'pending' });

    // Read 1 is handed the caller's own signal. Reads 2 and 3 share one
    // `openCopc` owns, so that either one's failure can end the other — and
    // the caller's abort still has to reach both of them through it.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(controller.signal);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[1]).not.toBe(controller.signal);

    controller.abort();
    await expect(opening).rejects.toBe(controller.signal.reason);
  });
});

// Two reads in flight at once means either one can be left behind by the
// other. Both tests below hold one read open forever, so an implementation
// that did not end it would fail them by timing out rather than by a diff.
describe('when one of the two concurrent reads fails', () => {
  /**
   * A reader that serves read 1 from the fixtures, fails whichever of the
   * other two starts at `failAt`, and leaves the remaining one hanging until
   * something aborts it.
   */
  function readerFailingAt(failAt: number, failure: Error) {
    const { reader } = autzenReader();
    const aborted: number[] = [];
    const gated: RangeReader = {
      ...reader,
      read: async (range, signal) => {
        if (range.offset === 0) {
          return reader.read(range, signal);
        }
        if (range.offset === failAt) {
          throw failure;
        }
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted.push(range.offset);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return reader.read(range, signal);
      },
    };
    return { reader: gated, aborted };
  }

  const VLR_REGION = 375;
  const ROOT_PAGE = 81_114_146;

  it('ends the root page read, and reports the VLR failure', async () => {
    const failure = new Error('the VLR region could not be read');
    const { reader, aborted } = readerFailingAt(VLR_REGION, failure);

    await expect(openCopc(reader)).rejects.toBe(failure);

    expect(aborted).toEqual([ROOT_PAGE]);
  });

  // The direction that needs the sentinel. The VLR read is ended by this
  // function, so its rejection describes nothing about the file — reporting
  // it would bury the root page failure that actually caused everything.
  it('ends the VLR read, and reports the root page failure rather than the abort it caused', async () => {
    const failure = new Error('the root hierarchy page could not be read');
    const { reader, aborted } = readerFailingAt(ROOT_PAGE, failure);

    await expect(openCopc(reader)).rejects.toBe(failure);

    expect(aborted).toEqual([VLR_REGION]);
  });
});
