import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

/**
 * Autzen's real WKT, read out of the pinned VLR region.
 *
 * Shared rather than copied because three test files now want the same bytes,
 * and a WKT that drifted between copies would let one of them pass against a
 * string the others never see.
 */
export async function autzenWkt(): Promise<string> {
  const header = Las.Header.parse(load('autzen-head.bin').subarray(0, 375));
  const region = load('autzen-vlrs.bin');
  const base = header.headerLength;
  const get = (begin: number, end: number): Promise<Uint8Array> =>
    Promise.resolve(region.subarray(begin - base, end - base));
  const vlrs = await Las.Vlr.walk(get, {
    headerLength: base,
    vlrCount: header.vlrCount,
    evlrOffset: 0,
    evlrCount: 0,
  });
  const record = Las.Vlr.at(vlrs, 'LASF_Projection', 2112);
  const start = record.contentOffset - base;
  return new TextDecoder()
    .decode(region.subarray(start, start + record.contentLength))
    .replace(/\0+$/, '');
}
