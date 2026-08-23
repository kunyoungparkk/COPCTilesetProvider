// A renderable COPC file assembled from the pinned slices in `fixtures/`, so
// the smoke has real points to draw without the 81 MB source. The chunk is
// the real node 5-16-3-1 from Autzen — 47 points the offline suite already
// decodes — so what renders here is the same data those tests measure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const POINTS = 47;
const POINT_DATA_OFFSET = 1736; // what the pinned header already declares
const ENTRY_BYTES = 32;
const INFO_VLR_BODY = 375 + 54; // header length + the VLR record header

export function buildFixture() {
  const head = fixture('autzen-head.bin');
  const vlrs = fixture('autzen-vlrs.bin');
  const chunk = fixture('autzen-node-5-16-3-1.bin');

  const pageAt = POINT_DATA_OFFSET + chunk.length;
  const file = new Uint8Array(pageAt + ENTRY_BYTES);
  file.set(head, 0);
  file.set(vlrs, 375); // overlaps the head's tail exactly as the real file does
  file.set(chunk, POINT_DATA_OFFSET);

  const page = new DataView(file.buffer, pageAt, ENTRY_BYTES);
  page.setInt32(0, 0, true); // key depth
  page.setInt32(4, 0, true); // x
  page.setInt32(8, 0, true); // y
  page.setInt32(12, 0, true); // z
  page.setBigUint64(16, BigInt(POINT_DATA_OFFSET), true);
  page.setInt32(24, chunk.length, true);
  page.setInt32(28, POINTS, true);

  const dv = new DataView(file.buffer);
  dv.setBigUint64(INFO_VLR_BODY + 40, BigInt(pageAt), true); // root_hier_offset
  dv.setBigUint64(INFO_VLR_BODY + 48, BigInt(ENTRY_BYTES), true); // root_hier_size
  dv.setUint32(107, POINTS, true); // legacy point count
  dv.setBigUint64(247, BigInt(POINTS), true); // 1.4 point count

  return file;
}

export const FIXTURE_POINTS = POINTS;
