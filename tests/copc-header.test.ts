import { describe, expect, it, vi } from 'vitest';
import { readFileHeader } from '../src/copc/header.js';
import type { RangeReader } from '../src/range/index.js';
import type { RecordingReader } from './fake-reader.js';
import { bufferReader } from './fake-reader.js';
import { FILE_URL, fixtureBytes, TOTAL_BYTES } from './fixtures.js';

const AUTZEN = fixtureBytes('autzen-head.bin');

/**
 * The shared buffer reader with this file's own default for the size a 206
 * discloses: every test here wants a real number except the one about a server
 * that discloses none.
 */
const headerReader = (
  bytes: Uint8Array,
  totalBytes: number | null = TOTAL_BYTES,
): RecordingReader => bufferReader(bytes, { totalBytes });

describe('readFileHeader', () => {
  it('reads the header and the info VLR in the one range Decision 4 specifies', async () => {
    const reader = headerReader(AUTZEN);

    const result = await readFileHeader(reader);

    expect(reader.reads).toEqual([{ offset: 0, length: 589 }]);
    expect(result.header.headerLength).toBe(375);
    expect(result.header.pointDataOffset).toBe(1736);
    expect(result.header.pointCount).toBe(10_653_336);
    expect(result.totalBytes).toBe(81_123_042);
  });

  it('parses the COPC info that sits at the fixed offset', async () => {
    const reader = headerReader(AUTZEN);

    const { info } = await readFileHeader(reader);

    expect(info.rootHierarchyPage).toEqual({ pageOffset: 81_114_146, pageLength: 8896 });
    expect(info.spacing).toBeCloseTo(36.371, 3);
  });

  it('rejects a file that is not LAS at all', async () => {
    const notLas = new Uint8Array(AUTZEN);
    notLas.set(new TextEncoder().encode('JUNK'), 0);
    const reader = headerReader(notLas);

    await expect(readFileHeader(reader)).rejects.toMatchObject({ code: 'not-copc' });
  });

  // Decision 4 reads the info VLR at 375 because the format fixes it there. A
  // different header length means that assumption is void, so the read that
  // just happened cannot be trusted — fail rather than parse garbage.
  it('rejects a header whose length is not 375', async () => {
    const shortHeader = new Uint8Array(AUTZEN);
    new DataView(shortHeader.buffer).setUint16(94, 227, true); // headerLength field
    const reader = headerReader(shortHeader);

    await expect(readFileHeader(reader)).rejects.toMatchObject({
      code: 'unsupported-header-layout',
      headerLength: 227,
    });
  });

  it('rejects a LAS file with no COPC info VLR where the format requires one', async () => {
    const noInfo = new Uint8Array(AUTZEN);
    noInfo.set(new TextEncoder().encode('other'), 375 + 2); // the VLR's userId field
    const reader = headerReader(noInfo);

    await expect(readFileHeader(reader)).rejects.toMatchObject({ code: 'not-copc' });
  });

  // The record says copc/1, but only its declared content length proves the 160
  // bytes behind it are the info payload. Parsing them regardless yields a cube
  // and a spacing that are wrong rather than absent, which shows up much later
  // as misplaced geometry.
  it('rejects a copc/1 record whose content is not the 160-byte info payload', async () => {
    const wrongLength = new Uint8Array(AUTZEN);
    new DataView(wrongLength.buffer).setUint16(375 + 20, 96, true); // contentLength field
    const reader = headerReader(wrongLength);

    const failure = readFileHeader(reader);

    await expect(failure).rejects.toMatchObject({ code: 'not-copc' });
    await expect(failure).rejects.toThrow('96');
  });

  // copc.js reads the root hierarchy page's offset and length as uint64 and
  // refuses anything above MAX_SAFE_INTEGER, with a bare Error naming no file.
  // This function's whole job is deciding whether the file is COPC, so its
  // verdict has to cover that too (Decision 6).
  it('rejects an info record whose root hierarchy page cannot be read', async () => {
    const hugePage = new Uint8Array(AUTZEN);
    hugePage.fill(0xff, 429 + 40, 429 + 48); // rootHierarchyPage.pageOffset
    const reader = headerReader(hugePage);

    const error = await readFileHeader(reader).then(
      () => undefined,
      (thrown: Error) => thrown,
    );

    expect(error).toMatchObject({ code: 'not-copc' });
    // Without the cause, the only explanation of what was wrong with the file
    // is discarded — the reason this test asserts it rather than the message.
    expect(error?.cause).toBeInstanceOf(Error);
    expect(String(error?.cause)).toContain('18446744073709551615');
  });

  it('passes an abort signal straight through to the reader', async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new Error('should not resolve'));
    const reader: RangeReader = { url: FILE_URL, read, readMany: vi.fn(), stats: vi.fn() };

    await expect(readFileHeader(reader, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledWith({ offset: 0, length: 589 }, controller.signal);
  });
});
