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
  source: string;
  totalBytes: number;
  cut: Record<string, { offset: number; length: number; sha256: string }>;
};

// These bytes are the only real COPC file the suite ever sees. If one is
// replaced or truncated, every downstream test fails with a parse error that
// says nothing about why — so say it here instead.
describe('pinned Autzen fixtures', () => {
  it('records where each slice came from', () => {
    expect(provenance.source).toContain('autzen');
    expect(provenance.totalBytes).toBe(81_123_042);
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

    const recorded = provenance.cut[name];
    expect(recorded?.length).toBe(length);
    expect(recorded?.offset).toBe(offset);
    expect(recorded?.sha256).toBe(digest);
  });

  it('starts with the LAS file signature', () => {
    expect(new TextDecoder().decode(fixture('autzen-head.bin').subarray(0, 4))).toBe('LASF');
  });
});
