import { Las } from 'copc';
import type { View } from 'copc';
import { getLazPerf } from './lazperf.js';

/**
 * The header fields decoding a chunk needs: the record layout for
 * `decompressChunk`, and the scale/offset `Las.View`'s X/Y/Z getters apply
 * internally (`node_modules/copc/lib/las/extractor.js`,
 * `Scale.unapply(dv.getInt32(...), scale[0], offset[0])`). The view hands
 * back file coordinates already scaled — this module does not repeat that
 * arithmetic.
 */
export type DecodeHeader = Pick<
  Las.Header,
  'pointDataRecordFormat' | 'pointDataRecordLength' | 'scale' | 'offset'
>;

/**
 * Decodes one COPC chunk's compressed bytes into a readable point view.
 *
 * `pointCount` comes from the hierarchy entry, which is the file's only
 * account of how many points the chunk holds — `decompressChunk` has no
 * independent way to discover that number, so it is not asked to. It decodes
 * exactly the count it is given and produces a buffer whose length is that
 * count times the record length, by construction — so `Las.View.create`'s
 * own point count, read back from the buffer, can only ever equal what was
 * asked for. No signal exists at this layer to check the hierarchy's count
 * against: `decompressChunk` never learns the compressed length either
 * (`node_modules/copc/lib/las/point-data.js:23` calls
 * `decoder.open(pointDataRecordFormat, pointDataRecordLength, blobPointer)`
 * with no length argument, and `laz-perf`'s `ChunkDecoder` has no way to
 * report how many points a chunk actually holds), so there is nothing here
 * to compare the given count against.
 *
 * An over-claimed count is not reliably a decode error either — measured
 * against this module's own fixture (47 real points, LAZ point format 7,
 * which is delta-predicted): claiming 48 decodes without error, and the one
 * fabricated point is 0.88m from the last real point, with the same GpsTime
 * and Classification — a near-duplicate, not garbage, because point14
 * predicts each point from the last one it saw and a `+1` over-claim asks
 * it to predict one point past the real data from data that is still
 * plausible. Claiming 1000 also decodes without error; the first point
 * outside the header's bounds is index 48 (the *second* fabricated point),
 * not 47 — a `+1` over-claim is systematically invisible to a bounds check,
 * and `+2` and beyond is systematically caught by one. Catching a lying
 * hierarchy is not this function's job: it belongs to whatever reads the
 * hierarchy page, and `src/copc/hierarchy.ts` does it — under Decision 6 it
 * refuses an entry whose count exceeds the file header's own total, which is
 * what keeps an absurd number from reaching the allocation below.
 *
 * `decompressChunk` reaches `laz-perf` directly and touches no I/O
 * (`node_modules/copc/lib/las/point-data.js`), so calling it here does not
 * cross the Decision 4 boundary the way copc.js's `Getter` layer would.
 */
export async function decodeChunk(
  compressed: Uint8Array,
  header: DecodeHeader,
  pointCount: number,
): Promise<View> {
  const decompressed = await Las.PointData.decompressChunk(
    compressed,
    {
      pointCount,
      pointDataRecordFormat: header.pointDataRecordFormat,
      pointDataRecordLength: header.pointDataRecordLength,
    },
    // Ours, not copc.js's own: theirs fetches a `.wasm` this bundle does not
    // ship as a file (`lazperf.ts`).
    await getLazPerf(),
  );
  return Las.View.create(decompressed, header);
}
