import type { View } from 'copc';
import { PositionCountMismatchError } from '../errors/index.js';
import type { RelativePositions } from './positions.js';

/**
 * Encodes a decoded COPC point view into a 3D Tiles 1.0 PNTS tile
 * (`Cesium3DTileContent`'s legacy point-cloud format — Decision 6).
 *
 * **The layout below is a contract on release.** A batch table's property
 * names and types are what a caller's styles and picking code are written
 * against; once a version ships with `GpsTime` as a double, removing it or
 * narrowing it breaks their code rather than ours. The set is therefore
 * decided here, with the Cesium behaviour verified rather than assumed
 * (`tests/worker-pnts.test.ts` parses the emitted bytes with Cesium's own
 * `PntsParser`).
 *
 * What ships, and why: `POSITION` (the caller's float32 tile-relative
 * positions) with `RTC_CENTER`; `RGB` from the file's own colour, which
 * Autzen carries because it is point format 7; `BATCH_ID` per point, so a
 * pick resolves to a point; and a batch table of classification, intensity,
 * GPS time, return number and number of returns — the five a point-cloud
 * viewer actually styles and filters on. `PointSourceId` is deliberately not
 * among them, and the reason is the shape of the bet rather than a guess at
 * how often callers want it: adding a property later is backward-compatible,
 * because every style string written against the existing set keeps working,
 * while removing or narrowing one is not. Leaving a property out is therefore
 * the reversible half and costs nothing permanent; putting one in is the half
 * that cannot be taken back.
 *
 * GPS time is safe only because `BATCH_ID` is present, and the two cannot be
 * revisited separately. Verified against installed Cesium 1.143.0 (`cesium`
 * is a thin re-export of `@cesium/engine`, whose readable source is what
 * actually runs — `tests/cesium-contract.test.ts` documents the same fact):
 * `Source/Scene/Model/PntsLoader.js:557-559` forks on
 * `const parseAsPropertyAttributes = !defined(parsedContent.batchIds)` —
 * with batch IDs the table becomes a property *table*, where
 * `Source/Scene/parseBatchTable.js:439-440` transcodes `"DOUBLE"` to
 * `"FLOAT64"` and precision survives; without them it becomes property
 * *attributes*, where `transcodeBinaryPropertiesAsPropertyAttributes` casts
 * every value to `Float32Array` and warns once (same file, lines 359-363).
 * Dropping `BATCH_ID` here would silently narrow every batch-table property
 * to float32 — this module keeps both together rather than letting a future
 * edit drop one and not the other. The file, not this module, decides which
 * GPS-time convention `GpsTime` uses (LAS's own `globalEncoding` bit chooses
 * between GPS Week Time and Adjusted Standard GPS Time), so the encoding
 * this module picks has to be correct for whichever one a given file turns
 * out to carry — not just the one the test fixture happens to use.
 */

// magic(4) + version(4) + byteLength(4) + 4 section-length fields(4 each) —
// the layout `node_modules/@cesium/engine/Source/Scene/PntsParser.js` reads
// bytes 0-27 as, in that order.
const HEADER_LENGTH = 28;
const MAGIC = 'pnts';

const textEncoder = new TextEncoder();

/**
 * `BATCH_ID`'s componentType, sized to the values it actually carries.
 *
 * Decision 6 gives each point its own batch (`BATCH_ID` per point, so a pick
 * resolves to a point), so the values run 0..count-1. The 3D Tiles
 * PointCloud spec allows `UNSIGNED_BYTE`, `UNSIGNED_SHORT` (its default), or
 * `UNSIGNED_INT`; the type must be able to represent every value up to
 * count-1, so the smallest of the three that fits is chosen: byte up to 256
 * points, short up to 65536, int beyond that. Getting a threshold wrong here
 * is silent, not a crash: a count of 257 written as `UNSIGNED_BYTE` wraps id
 * 256 to 0, so two different points share a batch id and a pick on either
 * resolves to whichever one Cesium happens to report — exactly the failure
 * `BATCH_ID` exists to prevent. `tests/worker-pnts.test.ts` pins both this
 * boundary (257 points) and the short/int one (65537) against a synthetic
 * view, not just the 47-point fixture, which never exercises either branch.
 */
function batchIdComponentType(count: number): { name: string; size: 1 | 2 | 4 } {
  if (count <= 256) return { name: 'UNSIGNED_BYTE', size: 1 };
  if (count <= 65536) return { name: 'UNSIGNED_SHORT', size: 2 };
  return { name: 'UNSIGNED_INT', size: 4 };
}

function writeBatchIds(count: number, size: 1 | 2 | 4): Uint8Array {
  if (size === 1) {
    const ids = new Uint8Array(count);
    for (let i = 0; i < count; i++) ids[i] = i;
    return ids;
  }
  if (size === 2) {
    const ids = new Uint16Array(count);
    for (let i = 0; i < count; i++) ids[i] = i;
    return new Uint8Array(ids.buffer);
  }
  const ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) ids[i] = i;
  return new Uint8Array(ids.buffer);
}

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
 * (`GpsTime` at 0, `Intensity` at `count*8`, both already multiples of their
 * own size by construction below) are what would matter, not this pad.
 * Aligning it here anyway keeps one rule instead of two, and is what makes
 * this layout safe for the widest component type it could ever carry
 * (`GpsTime`, a `float64`) without needing to know in advance which future
 * property might need it.
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
 * LAS colour is 16-bit (`Red`/`Green`/`Blue`), PNTS `RGB` is 8-bit per
 * channel, so some conversion has to happen; `>>> 8` is what this module
 * does, unconditionally, for every file. What settles that choice for
 * *this* file: measured on `fixtures/autzen-node-5-16-3-1.bin` (47 points,
 * all three channels, every point), every value is an exact multiple of 256
 * and none is a multiple of 257 — this file's real colour precision is 8
 * bits, left-shifted into the high byte of a 16-bit field, not a genuine
 * 16-bit sample, so `>>> 8` recovers those 8 bits exactly (no rounding: the
 * low byte is always zero) and neither blacks out this fixture's low end
 * (min Red 11520 -> 45) nor blows out its high end (max Red 17920 -> 70).
 * What that measurement does *not* settle: a writer that stores genuine
 * 8-bit colour unscaled in the low byte of these 16-bit fields (rather than
 * left-shifted into the high byte) would go uniformly, silently black under
 * `>>> 8` — this module does not detect or correct for that, and does not
 * attempt a per-tile heuristic to guess it, because a per-tile guess is
 * worse than a wrong constant: neighbouring tiles could each guess
 * differently and scale their colour inconsistently, producing a visible
 * seam between tiles that a single wrong-but-uniform rule would not. A
 * whole-file decision (inspecting the header or a wider sample once, at
 * `fromUrl` time) is where that question belongs, not here, one chunk at a
 * time.
 */
export function encodePnts(view: View, placed: RelativePositions): ArrayBuffer {
  const count = view.pointCount;

  if (placed.positions.length !== count * 3) {
    throw new PositionCountMismatchError(count, placed.positions.length);
  }

  const getRed = view.getter('Red');
  const getGreen = view.getter('Green');
  const getBlue = view.getter('Blue');
  const getClassification = view.getter('Classification');
  const getIntensity = view.getter('Intensity');
  const getGpsTime = view.getter('GpsTime');
  const getReturnNumber = view.getter('ReturnNumber');
  const getNumberOfReturns = view.getter('NumberOfReturns');

  const batchId = batchIdComponentType(count);

  // --- Feature table: POSITION, BATCH_ID, RGB, in that order. ---
  // POSITION first keeps it at relative offset 0 (trivially aligned to its
  // own 4-byte float, and to the 8-byte boundary padTrailing now guarantees
  // for the section itself). BATCH_ID follows at `count * 12`, itself always
  // a multiple of 4 for integer `count`, so it stays aligned whichever of
  // the three componentTypes above was chosen. RGB is last and one byte
  // wide, so it never needs alignment at all.
  const positionBytes = new Uint8Array(
    placed.positions.buffer,
    placed.positions.byteOffset,
    placed.positions.byteLength,
  );
  const batchIdBytes = writeBatchIds(count, batchId.size);
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = getRed(i) >>> 8;
    rgb[i * 3 + 1] = getGreen(i) >>> 8;
    rgb[i * 3 + 2] = getBlue(i) >>> 8;
  }
  const featureTableBinary = concatBytes([positionBytes, batchIdBytes, rgb]);

  const featureTableJson = {
    POINTS_LENGTH: count,
    RTC_CENTER: placed.rtcCenter,
    POSITION: { byteOffset: 0 },
    BATCH_ID: { byteOffset: positionBytes.byteLength, componentType: batchId.name },
    RGB: { byteOffset: positionBytes.byteLength + batchIdBytes.byteLength },
    BATCH_LENGTH: count,
  };
  const featureTableJsonPadded = padTrailing(JSON.stringify(featureTableJson), HEADER_LENGTH);

  // --- Batch table: GpsTime, Intensity, Classification, ReturnNumber,
  // NumberOfReturns, in that order. ---
  // GpsTime (float64, 8 bytes) goes first at relative offset 0; Intensity
  // (uint16) then sits at `count * 8`, always a multiple of 2; the three
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
  const gpsTime = new Float64Array(count);
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
    GpsTime: { byteOffset: 0, componentType: 'DOUBLE', type: 'SCALAR' },
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
