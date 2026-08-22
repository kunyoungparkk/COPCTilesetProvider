import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeHierarchyPage } from './hierarchy-page.js';
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
    // The read that would ask for the (now nonsensical) root page never
    // happens: openCopc refuses before it is ever built.
    expect(reads).toEqual([
      { offset: 0, length: 589 },
      { offset: 375, length: 1361 },
    ]);
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

  // COPC allows point data record formats 6, 7 and 8, and only 7 and 8 carry
  // RGB (copc.js's own extractor for format 6 defines no Red/Green/Blue).
  // This library encodes RGB into every PNTS tile, so a format-6 file has
  // nothing to render from — refusing at open names the file once, instead
  // of an untyped throw per tile inside a Worker after the globe has loaded.
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

    it('refuses a format that carries no colour', async () => {
      const { reader, reads } = autzenReader();
      const withFormat6 = withPatchedHead(reader, reads, patchPointFormat(6));

      const failure = openCopc(withFormat6);

      await expect(failure).rejects.toMatchObject({
        code: 'unsupported-point-format',
        pointDataRecordFormat: 6,
      });
      await expect(failure).rejects.toThrow('https://host/autzen.copc.laz');
      await expect(failure).rejects.toThrow('6');
    });

    it('opens formats 7 and 8, which carry RGB', async () => {
      const { reader, reads } = autzenReader();
      // Autzen is already format 7; format 8 is the one that needs constructing.
      // Only the format byte is patched, so this file is not a real format-8
      // record — a genuine one is 38 bytes per point rather than the 36 the
      // header still declares. `openCopc` never reads a point body, so the
      // inconsistency is invisible to what is under test, and what this pins
      // is exactly one thing: 8 is on the accepted side of the check.
      const withFormat8 = withPatchedHead(reader, reads, patchPointFormat(8));

      const file = await openCopc(withFormat8);

      expect(file.header.pointDataRecordFormat).toBe(8);
    });

    it('refuses before the hierarchy page is read', async () => {
      const { reader, reads } = autzenReader();
      const withFormat6 = withPatchedHead(reader, reads, patchPointFormat(6));

      await expect(openCopc(withFormat6)).rejects.toMatchObject({
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
