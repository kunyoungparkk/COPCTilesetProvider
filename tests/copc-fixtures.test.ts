import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const provenance = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/provenance.json', import.meta.url)), 'utf8'),
) as {
  sources: {
    source: string;
    totalBytes: number;
    cut: Record<string, { offset: number; length: number; sha256: string }>;
  }[];
};

/** The recorded cut for one slice, whichever source it came from. */
const cutOf = (name: string) => provenance.sources.find((s) => s.cut[name])?.cut[name];

// These bytes are the only real COPC files the suite ever sees. If one is
// replaced or truncated, every downstream test fails with a parse error that
// says nothing about why — so say it here instead.
describe('pinned Autzen fixtures', () => {
  it('records where each slice came from', () => {
    const autzen = provenance.sources.find((s) => s.source.includes('autzen'));
    expect(autzen?.totalBytes).toBe(81_123_042);
  });

  // Length alone does not pin these bytes: zeroing a fixture in place, or
  // flipping one byte inside the WKT, leaves every length intact. The digest
  // is the actual pin; the length and offset stay because they say plainly
  // what went wrong when it is a truncation or a re-cut at the wrong place.
  //
  // Each fact is asserted twice, against a literal here and against
  // provenance.json, so a re-cut that refreshes provenance still trips the
  // literal and has to be looked at by a human.
  it.each([
    ['autzen-head.bin', 589, 0, '784841800b5b03619ee3b568f9ff5ac407e1ddff46ba317048597d938401063d'],
    ['autzen-vlrs.bin', 1361, 375, 'd696b7b86708050f3f2bd02f36a0c9e77f4e6c2d45309fd1d662e2d0a33e7297'],
    [
      'autzen-root-hierarchy.bin',
      8896,
      81_114_146,
      'b937e87a8b7b9d7e62bff0e431d349a4d84709fd60c1cfcd3e4dc863253c4d53',
    ],
    [
      'autzen-node-5-16-3-1.bin',
      951,
      53_565_789,
      '32bc4c827b9eff0888ceec7f26f17c032def30b823f0afc266d8b423e2b18591',
    ],
  ])('%s is exactly %i bytes cut from offset %i, byte for byte', (name, length, offset, digest) => {
    const bytes = fixture(name);
    expect(bytes).toHaveLength(length);
    expect(sha256(bytes)).toBe(digest);

    const recorded = cutOf(name);
    expect(recorded?.length).toBe(length);
    expect(recorded?.offset).toBe(offset);
    expect(recorded?.sha256).toBe(digest);
  });

  it('starts with the LAS file signature', () => {
    expect(new TextDecoder().decode(fixture('autzen-head.bin').subarray(0, 4))).toBe('LASF');
  });
});

// A second source, for the one property no single file can cover: COPC allows
// point formats 6, 7 and 8, and a file is exactly one of them. Autzen is 7 and
// carries colour, SoFi is 6 and carries none. Only two slices are cut — the
// header and one chunk — because that is all a decode needs; SoFi's hierarchy
// page is 86 KB and holds nothing about point format.
describe('pinned SoFi fixtures (LAS point format 6)', () => {
  it('records where each slice came from', () => {
    const sofi = provenance.sources.find((s) => s.source.includes('sofi'));
    expect(sofi?.totalBytes).toBe(2_029_696_615);
  });

  it.each([
    ['sofi-head.bin', 589, 0, 'cea38cd767d5601577e3858e0447fb1a8e441bc476a0e26d07baa532eb39b0b3'],
    [
      'sofi-node-6-23-29-3.bin',
      608,
      407_039_109,
      '98405d2d7ca1a22b164c10469089cd1c87004a4ac26f615bf8a16e72efc3c3f1',
    ],
  ])('%s is exactly %i bytes cut from offset %i, byte for byte', (name, length, offset, digest) => {
    const bytes = fixture(name);
    expect(bytes).toHaveLength(length);
    expect(sha256(bytes)).toBe(digest);

    const recorded = cutOf(name);
    expect(recorded?.length).toBe(length);
    expect(recorded?.offset).toBe(offset);
    expect(recorded?.sha256).toBe(digest);
  });

  it('declares point format 6 with no colour, in its low nibble', () => {
    // The reason this fixture exists at all, asserted on the bytes rather
    // than taken on trust from the filename. Byte 104 packs the format in its
    // low nibble and LAZ's compression flag in the high bit, so both are
    // read: a fixture that lost the flag would be an uncompressed file and
    // would decode as garbage rather than fail.
    const byte104 = fixture('sofi-head.bin')[104]!;
    expect(byte104 & 0b1111).toBe(6);
    expect(byte104 & 0b1000_0000).toBeTruthy();
  });
});
