import { Las } from 'copc';
import { describe, expect, it, vi } from 'vitest';
import { readWkt } from '../src/copc/wkt.js';
import type { RangeReader } from '../src/range/index.js';
import { bufferReader } from './fake-reader.js';
import { FILE_URL, fixtureBytes as load, TOTAL_BYTES } from './fixtures.js';

const HEAD = load('autzen-head.bin');
const VLRS = load('autzen-vlrs.bin');
const HEADER = Las.Header.parse(HEAD.subarray(0, 375));

/** Serves the VLR region at its real file offset, and nothing else. */
function vlrReader(region: Uint8Array = VLRS, header: Las.Header = HEADER) {
  const reader = bufferReader(region, {
    baseOffset: header.headerLength,
    totalBytes: TOTAL_BYTES,
  });
  return { reader, reads: reader.reads };
}

const VLR_HEADER_LENGTH = 54;

// Where Autzen's WKT record begins inside the region: 54 + 160 for the copc
// info record, then 54 + 46 for the laszip one. Slicing here keeps the two
// records that are not WKT and drops the one that is.
const WKT_RECORD_START = 314;

/**
 * Builds a VLR region holding one WKT record with exactly these content bytes.
 *
 * Autzen's record is 993 bytes with no padding at all, so the padding LAS 1.4
 * calls for has no fixture — these bytes are the only way to reach that branch.
 */
function wktRegion(content: Uint8Array): { region: Uint8Array; header: Las.Header } {
  const region = new Uint8Array(VLR_HEADER_LENGTH + content.length);
  const view = new DataView(region.buffer);
  // LAS VLR header layout: 2 reserved bytes, 16-byte userId, then the two
  // uint16 fields below, then a 32-byte description.
  region.set(new TextEncoder().encode('LASF_Projection'), 2);
  view.setUint16(18, 2112, true); // recordId
  view.setUint16(20, content.length, true); // contentLength
  region.set(content, VLR_HEADER_LENGTH);

  const header: Las.Header = {
    ...HEADER,
    vlrCount: 1,
    evlrCount: 0,
    pointDataOffset: HEADER.headerLength + region.length,
  };
  return { region, header };
}

describe('readWkt', () => {
  it('reads the whole VLR region in one request', async () => {
    const { reader, reads } = vlrReader();

    await readWkt(reader, HEADER);

    // headerLength to pointDataOffset — both reported by the header we already read.
    expect(reads).toEqual([{ offset: 375, length: 1361 }]);
  });

  it('returns the WKT string as written, without interpreting it', async () => {
    const { reader } = vlrReader();

    const wkt = await readWkt(reader, HEADER);

    // Autzen's is a compound CRS. Decision 6 refuses to hand this to proj4
    // whole, which is why this module returns text and stops there.
    expect(wkt?.startsWith('COMPD_CS[')).toBe(true);
    expect(wkt).toContain('NAD83 / Oregon GIC Lambert (ft)');
    expect(wkt).not.toMatch(/\0/);
  });

  it('returns undefined when the file has no WKT and no extended VLRs', async () => {
    const header = { ...HEADER, vlrCount: 0, evlrCount: 0, pointDataOffset: 375 };
    const { reader } = vlrReader(new Uint8Array(0), header);

    expect(await readWkt(reader, header)).toBeUndefined();
  });

  // Silently reporting "no CRS" for a file that has one, stored somewhere we do
  // not look, would surface later as a confusing CRS failure.
  it('says so when the WKT might be in an extended VLR', async () => {
    const header = { ...HEADER, vlrCount: 0, evlrCount: 1, pointDataOffset: 375 };
    const { reader } = vlrReader(new Uint8Array(0), header);

    await expect(readWkt(reader, header)).rejects.toMatchObject({ code: 'wkt-not-in-vlrs' });
  });

  // The real reader rejects a zero-length range as a caller bug
  // (InvalidByteRangeError), so the case above reaches its answer only because
  // no request goes out at all.
  it('asks for nothing when the VLR region is empty', async () => {
    const header = { ...HEADER, vlrCount: 0, evlrCount: 0, pointDataOffset: 375 };
    const { reader, reads } = vlrReader(new Uint8Array(0), header);

    await readWkt(reader, header);

    expect(reads).toEqual([]);
  });

  it('strips the null padding a writer left after the string', async () => {
    const { region, header } = wktRegion(new TextEncoder().encode('GEOGCS["WGS 84"]\0\0\0'));
    const { reader } = vlrReader(region, header);

    expect(await readWkt(reader, header)).toBe('GEOGCS["WGS 84"]');
  });

  it('treats a record that is nothing but padding as no CRS at all', async () => {
    const { region, header } = wktRegion(new Uint8Array(4));
    const { reader } = vlrReader(region, header);

    expect(await readWkt(reader, header)).toBeUndefined();
  });

  // The file shape WktNotInVlrsError's own message describes: VLRs present,
  // none of them the WKT record. Without this the absent-record route can
  // return a bare undefined and ship green.
  it('says so when VLRs are present but none of them is the WKT record', async () => {
    const region = VLRS.slice(0, WKT_RECORD_START);
    const header: Las.Header = {
      ...HEADER,
      vlrCount: 2,
      evlrCount: 1,
      pointDataOffset: HEADER.headerLength + region.length,
    };
    const { reader } = vlrReader(region, header);

    await expect(readWkt(reader, header)).rejects.toMatchObject({ code: 'wkt-not-in-vlrs' });
  });

  // A record that trims to nothing is a missing record, so the same judgement
  // has to apply: the real one could be in an extended VLR. Answering undefined
  // here is the silent "no CRS" absentWkt exists to prevent.
  it('says so when an all-padding record sits beside extended VLRs', async () => {
    const { region, header } = wktRegion(new Uint8Array(4));
    const withEvlrs: Las.Header = { ...header, evlrCount: 1 };
    const { reader } = vlrReader(region, withEvlrs);

    await expect(readWkt(reader, withEvlrs)).rejects.toMatchObject({ code: 'wkt-not-in-vlrs' });
  });

  // The counterpart of the case above: the same absent record, but nothing
  // suggesting the WKT is elsewhere, so undefined is the honest answer. The
  // empty-region case reaches undefined by the early return instead, which
  // leaves this branch of the record lookup unvisited.
  it('returns undefined when the VLRs it walks include no WKT record', async () => {
    const region = VLRS.slice(0, WKT_RECORD_START);
    const header: Las.Header = {
      ...HEADER,
      vlrCount: 2,
      evlrCount: 0,
      pointDataOffset: HEADER.headerLength + region.length,
    };
    const { reader } = vlrReader(region, header);

    expect(await readWkt(reader, header)).toBeUndefined();
  });

  // A vlrCount larger than the region holds walks off its end, and copc.js
  // reports that as a bare Error naming no file. Decision 6 does not let one
  // reach a caller, and the fault is the file's description of its own VLRs.
  it('reports a VLR region that does not hold the records the header declares', async () => {
    const header: Las.Header = { ...HEADER, vlrCount: HEADER.vlrCount + 1 };
    const { reader } = vlrReader(VLRS, header);

    const error = await readWkt(reader, header).then(
      () => undefined,
      (thrown: Error) => thrown,
    );

    expect(error).toMatchObject({ code: 'not-copc' });
    expect(error?.message).toContain('https://host/autzen.copc.laz');
    expect(error?.cause).toBeInstanceOf(Error);
    expect(String(error?.cause)).toContain('Invalid VLR header length');
  });

  // Decoding the clamped slice instead would hand the CRS module a truncated
  // WKT, which fails there as "no EPSG code" — a complaint about the wrong
  // thing, one module away from the file that caused it.
  it('refuses a WKT record that declares more bytes than the region holds', async () => {
    const { region, header } = wktRegion(new TextEncoder().encode('GEOGCS["WGS 84"]'));
    // The record's own header now claims content that runs past the region.
    new DataView(region.buffer).setUint16(20, region.length, true);
    const { reader } = vlrReader(region, header);

    const failure = readWkt(reader, header);

    await expect(failure).rejects.toMatchObject({ code: 'not-copc' });
    await expect(failure).rejects.toThrow(String(region.length));
  });

  it('passes an abort signal straight through to the reader', async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new Error('should not resolve'));
    const reader = { url: FILE_URL, read } as unknown as RangeReader;

    await expect(readWkt(reader, HEADER, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledWith({ offset: 375, length: 1361 }, controller.signal);
  });
});
