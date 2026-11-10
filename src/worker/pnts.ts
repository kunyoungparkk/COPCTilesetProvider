import type { View } from 'copc';
import { PositionCountMismatchError } from '../errors/index.js';
import type { RelativePositions } from './positions.js';

/**
 * Encodes a decoded COPC point view into a 3D Tiles 1.0 PNTS tile
 * (`Cesium3DTileContent`'s legacy point-cloud format — Decision 6).
 *
 * **The layout below is a contract on release.** A batch table's property
 * names and types are what a caller's styles are written against; once a
 * version ships with `Intensity` as a uint16, removing it or narrowing it
 * breaks their code rather than ours. The set is therefore decided here, with
 * the Cesium behaviour verified rather than assumed (`tests/worker-pnts.test.ts`
 * reads the emitted bytes back with Cesium's own `PntsParser` and
 * `parseBatchTable`).
 *
 * What ships, and why: `POSITION` (the caller's float32 tile-relative
 * positions) with `RTC_CENTER`; `RGB` from the file's own colour, for the two
 * of COPC's three point formats that carry any — Autzen is format 7, which
 * does, and a format-6 tile ships without the section, which Cesium renders
 * as its own constant dark grey (`Model/PntsLoader.js`'s
 * `defaultColorAttribute`) until a style says otherwise; and a batch table of
 * classification, intensity, GPS time, return number and number of returns —
 * the five a point-cloud viewer actually styles and filters on.
 * `PointSourceId` is deliberately not among them, and the reason is the shape
 * of the bet rather than a guess at how often callers want it: adding a
 * property later is backward-compatible, because every style string written
 * against the existing set keeps working, while removing or narrowing one is
 * not. Leaving a property out is therefore the reversible half and costs
 * nothing permanent; putting one in is the half that cannot be taken back.
 *
 * **There is no `BATCH_ID`, and that absence decides where styling runs**
 * (Decision 6). Cesium's `PntsLoader` reads a tile that has batch IDs as a
 * property *table*: it builds one `Cesium3DTileFeature` per point as the tile
 * loads, and evaluates every style on the main thread, one point at a time.
 * Without batch IDs the same batch table becomes property *attributes*: vertex
 * buffers a style compiles into the point shader, with no per-point object,
 * and each attribute's CPU copy freed once it is uploaded.
 * `tests/cesium-contract.test.ts` pins that fork. The price is picking a
 * single point: `scene.pick` resolves to the tile's content, not to a point
 * and its properties.
 *
 * The same absence decides `GpsTime`'s type. WebGL has no double-precision
 * vertex attribute, so `parseBatchTable` would cast a `DOUBLE` to float32 and
 * say so on the console; writing `FLOAT` stores the identical value without
 * the warning. How much of a GPS time float32 keeps is the file's to decide,
 * since LAS's `globalEncoding` bit picks the convention: GPS Week Time stays
 * under 604,800 s, where a float32 step is 1/16 s or finer (1/64 s on both
 * pinned fixtures), while Adjusted Standard GPS Time sits near 3e8 s, where
 * the step is 32 s.
 */

// magic(4) + version(4) + byteLength(4) + 4 section-length fields(4 each) —
// the layout `node_modules/@cesium/engine/Source/Scene/PntsParser.js` reads
// bytes 0-27 as, in that order.
const HEADER_LENGTH = 28;
const MAGIC = 'pnts';

const textEncoder = new TextEncoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Pads a JSON chunk with trailing spaces (ignored by `JSON.parse`) until the
 * byte that follows it — `precedingBytes` plus the chunk's own length — sits
 * on an 8-byte boundary, uniformly for both JSON chunks this module writes.
 *
 * The two chunks need this for different reasons, and only one of them needs
 * it from Cesium today. The feature table's binary section is read back with
 * `ComponentDatatype.createArrayBufferView`
 * (`node_modules/@cesium/engine/Source/Core/ComponentDatatype.js:295-298`)
 * constructing a `Float32Array` directly over the tile's own `ArrayBuffer`
 * (`PntsParser.js:77` takes that section as a live view, no copy) — the
 * platform requires that view's byte offset be a multiple of its element
 * size, or the constructor throws, so this alignment is load-bearing there.
 * The batch table's binary section, by contrast, is copied into a fresh
 * standalone buffer before parsing (`PntsParser.js:101-107`,
 * `new Uint8Array(batchTableBinary)` starting the copy at its own byte 0),
 * so nothing downstream ever constructs a typed array offset by where this
 * section sat in the original tile — its own properties' *relative* offsets
 * (`GpsTime` at 0, `Intensity` at `count*4`, both already multiples of their
 * own size by construction below) are what would matter, not this pad.
 * Aligning it here anyway keeps one rule instead of two, and is what makes
 * this layout safe for an 8-byte component type without needing to know in
 * advance which future property might need one.
 */
function padTrailing(json: string, precedingBytes: number): string {
  let padded = json;
  while ((precedingBytes + padded.length) % 8 !== 0) padded += ' ';
  return padded;
}

/**
 * Builds the 3D Tiles 1.0 PNTS bytes for one decoded chunk.
 *
 * `view` supplies colour and the five batch-table attributes, read here
 * with its own getters rather than by the caller — it is the one place that
 * knows which dimensions this point format carries (Autzen's point format 7
 * has `Red`/`Green`/`Blue`; a caller guessing at that split across two
 * modules is how the two would disagree). `placed` supplies the positions
 * `toRelativePositions` already transformed and centred;
 * `placed.positions.length` must be
 * `view.pointCount * 3`, matching what `toRelativePositions` always produces
 * for the same view — checked below, unlike `decodeChunk`, which does not
 * re-verify the hierarchy's point count. The two checks are not parallel:
 * `decodeChunk` has no independent count to check `pointCount` against (both
 * come from the same hierarchy entry), but `count` and `placed.positions`
 * are two separately-computed values that are only ever supposed to agree,
 * so disagreement here is actually detectable — see
 * `PositionCountMismatchError`'s own doc comment for why the check stays
 * even though nothing in this library's own pipeline can trigger it.
 *
 * A view whose format carries no colour (LAS point format 6, one of the three
 * COPC allows) gets no `RGB` section at all. It sits last in the feature
 * table and is the only section whose length is not already a multiple of 8,
 * so omitting it moves no other section's byte offset and the layout's
 * alignment rule is unchanged — `tests/worker-pnts.test.ts` pins both facts
 * rather than leaving them as reasoning. Cesium then renders the tile in the
 * constant dark grey `Model/PntsLoader.js:508` holds for exactly this case;
 * no colour is invented here, because a value this library made up would be
 * indistinguishable, to a caller, from one the file supplied.
 *
 * LAS colour fields are 16 bits wide and PNTS `RGB` is 8 bits per channel.
 * Writers fill the fields two ways and no file says which: scaled to the full
 * 16 bits, as the LAS specification asks, or holding 8-bit values as they
 * were. The second kind renders black under a plain `>>> 8`. So the chunk
 * decides: if any of its colour values exceeds 255 the fields are in use at
 * 16 bits and every value gives its high byte, and otherwise every value is
 * kept as it is. `@loaders.gl/las` draws the same line under its
 * `colorDepth: 'auto'` (4.5.4, `parse-las.ts`).
 *
 * Measured over every chunk of four public files (hobu-lidar, 1,956 chunks,
 * 46.5 million points): the two that scale, autzen-classified and
 * autzen-2023, have a value above 255 in all 1,537 of their chunks, each one
 * a multiple of 256, so `>>> 8` loses nothing; the two that do not,
 * autzen.large and redrocks.large, have none above 255 in any of their 419.
 * No chunk decided differently from the rest of its file.
 *
 * The rule is applied per chunk, and that leaves one case open. It parts
 * from a plain `>>> 8` only on a chunk of a 16-bit file whose every value is
 * 255 or less: all zeros render black either way, and anything else there
 * renders too bright where `>>> 8` would have rendered it black. That takes
 * colour sampled at a true 16 bits — 8-bit colour scaled up holds no value
 * from 1 to 255 — and a chunk dark throughout. One decision per file would
 * close the case, but it has to be made from points, and `fromUrl` reads
 * none (OVERVIEW §4).
 *
 * A file whose colour is all zeros is left alone and renders black. Dropping
 * `RGB` for an all-zero chunk would turn the uncoloured gaps of a coloured
 * file grey, tile by tile.
 */
export function encodePnts(view: View, placed: RelativePositions): ArrayBuffer {
  const count = view.pointCount;

  if (placed.positions.length !== count * 3) {
    throw new PositionCountMismatchError(count, placed.positions.length);
  }

  // COPC allows point formats 6, 7 and 8; only 7 and 8 carry colour, so this
  // is one of the three shapes a valid file arrives in, not an error case.
  // The view is asked rather than the header because the view is the one
  // place that knows which dimensions its format carries — `Dimensions.create`
  // and `getter` are built from the same extractor map, so they cannot
  // disagree, while a second format-number test in this module could drift
  // from the one in `src/copc/open.ts`. Measured across all three formats:
  // `Red` is among a view's dimensions for 7 and 8, and absent for 6
  // (`copc.js`'s `create7` introduces all three channels together, so the one
  // test settles the other two).
  const hasColour = view.dimensions.Red !== undefined;

  const getClassification = view.getter('Classification');
  const getIntensity = view.getter('Intensity');
  const getGpsTime = view.getter('GpsTime');
  const getReturnNumber = view.getter('ReturnNumber');
  const getNumberOfReturns = view.getter('NumberOfReturns');

  // --- Feature table: POSITION, then RGB. No BATCH_ID: see the module doc. ---
  // POSITION first keeps it at relative offset 0 (trivially aligned to its
  // own 4-byte float, and to the 8-byte boundary padTrailing guarantees for
  // the section itself). RGB is last and one byte wide, so it never needs
  // alignment at all.
  const positionBytes = new Uint8Array(
    placed.positions.buffer,
    placed.positions.byteOffset,
    placed.positions.byteLength,
  );
  let rgb: Uint8Array | undefined;
  if (hasColour) {
    const getRed = view.getter('Red');
    const getGreen = view.getter('Green');
    const getBlue = view.getter('Blue');
    let largest = 0;
    for (let i = 0; i < count; i++) {
      largest = Math.max(largest, getRed(i), getGreen(i), getBlue(i));
    }
    // One answer for the whole chunk, never one per point: a dark point in a
    // 16-bit chunk has to scale with its neighbours.
    const shift = largest > 255 ? 8 : 0;
    rgb = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      rgb[i * 3] = getRed(i) >>> shift;
      rgb[i * 3 + 1] = getGreen(i) >>> shift;
      rgb[i * 3 + 2] = getBlue(i) >>> shift;
    }
  }
  const featureTableBinary = concatBytes(rgb ? [positionBytes, rgb] : [positionBytes]);

  const featureTableJson = {
    POINTS_LENGTH: count,
    RTC_CENTER: placed.rtcCenter,
    POSITION: { byteOffset: 0 },
    ...(rgb && { RGB: { byteOffset: positionBytes.byteLength } }),
  };
  const featureTableJsonPadded = padTrailing(JSON.stringify(featureTableJson), HEADER_LENGTH);

  // --- Batch table: GpsTime, Intensity, Classification, ReturnNumber,
  // NumberOfReturns, in that order. ---
  // GpsTime (float32, 4 bytes) goes first at relative offset 0; Intensity
  // (uint16) then sits at `count * 4`, always a multiple of 2; the three
  // byte-wide properties that follow (Classification, ReturnNumber,
  // NumberOfReturns) need no alignment. None of this is required by Cesium
  // today (padTrailing's doc comment above says why), but keeping the same
  // layout as the feature table means one mental model for both.
  //
  // ReturnNumber and NumberOfReturns both come from a 4-bit subfield of the
  // point record (`node_modules/copc/lib/las/extractor.js`'s `create6`, the
  // PDRF 6/7/8 path COPC requires), so every value is 0-15 by construction —
  // measured on the 47-point fixture, ReturnNumber is always 1 and
  // NumberOfReturns ranges 1-4. `UNSIGNED_BYTE` is the smallest 3D Tiles
  // batch-table componentType that can hold that range, matching the
  // existing choice for `Classification`.
  const gpsTime = new Float32Array(count);
  const intensity = new Uint16Array(count);
  const classification = new Uint8Array(count);
  const returnNumber = new Uint8Array(count);
  const numberOfReturns = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    gpsTime[i] = getGpsTime(i);
    intensity[i] = getIntensity(i);
    classification[i] = getClassification(i);
    returnNumber[i] = getReturnNumber(i);
    numberOfReturns[i] = getNumberOfReturns(i);
  }
  const gpsTimeBytes = new Uint8Array(gpsTime.buffer);
  const intensityBytes = new Uint8Array(intensity.buffer);
  const unpaddedBatchTableBinary = concatBytes([
    gpsTimeBytes,
    intensityBytes,
    classification,
    returnNumber,
    numberOfReturns,
  ]);

  const classificationByteOffset = gpsTimeBytes.byteLength + intensityBytes.byteLength;
  const returnNumberByteOffset = classificationByteOffset + classification.byteLength;
  const numberOfReturnsByteOffset = returnNumberByteOffset + returnNumber.byteLength;
  const batchTableJson = {
    GpsTime: { byteOffset: 0, componentType: 'FLOAT', type: 'SCALAR' },
    Intensity: { byteOffset: gpsTimeBytes.byteLength, componentType: 'UNSIGNED_SHORT', type: 'SCALAR' },
    Classification: { byteOffset: classificationByteOffset, componentType: 'UNSIGNED_BYTE', type: 'SCALAR' },
    ReturnNumber: { byteOffset: returnNumberByteOffset, componentType: 'UNSIGNED_BYTE', type: 'SCALAR' },
    NumberOfReturns: { byteOffset: numberOfReturnsByteOffset, componentType: 'UNSIGNED_BYTE', type: 'SCALAR' },
  };
  const precedingBatchTableJson = HEADER_LENGTH + featureTableJsonPadded.length + featureTableBinary.byteLength;
  const batchTableJsonPadded = padTrailing(JSON.stringify(batchTableJson), precedingBatchTableJson);

  // The tile's own total length gets the same 8-byte treatment as every
  // section boundary above it — one alignment rule for the whole layout,
  // not a different one per section. Trailing zero bytes are appended to
  // the batch table binary itself, so its own declared byteLength (below)
  // always equals the buffer's actual tail, rather than leaving
  // unaccounted-for bytes after the last declared section.
  const unpaddedTotalLength =
    precedingBatchTableJson + batchTableJsonPadded.length + unpaddedBatchTableBinary.byteLength;
  const tailPadding = (8 - (unpaddedTotalLength % 8)) % 8;
  const batchTableBinary =
    tailPadding === 0
      ? unpaddedBatchTableBinary
      : concatBytes([unpaddedBatchTableBinary, new Uint8Array(tailPadding)]);
  const totalLength = unpaddedTotalLength + tailPadding;

  const buffer = new ArrayBuffer(totalLength);
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  bytes.set(textEncoder.encode(MAGIC), 0);
  dv.setUint32(4, 1, true); // version
  dv.setUint32(8, totalLength, true); // byteLength
  dv.setUint32(12, featureTableJsonPadded.length, true);
  dv.setUint32(16, featureTableBinary.byteLength, true);
  dv.setUint32(20, batchTableJsonPadded.length, true);
  dv.setUint32(24, batchTableBinary.byteLength, true);

  let offset = HEADER_LENGTH;
  bytes.set(textEncoder.encode(featureTableJsonPadded), offset);
  offset += featureTableJsonPadded.length;
  bytes.set(featureTableBinary, offset);
  offset += featureTableBinary.byteLength;
  bytes.set(textEncoder.encode(batchTableJsonPadded), offset);
  offset += batchTableJsonPadded.length;
  bytes.set(batchTableBinary, offset);

  return buffer;
}
