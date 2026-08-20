import { Las } from 'copc';
import { NotCopcError, WktNotInVlrsError } from '../errors/index.js';
import type { RangeReader } from '../range/index.js';

const WKT_USER_ID = 'LASF_Projection';
const WKT_RECORD_ID = 2112;

/**
 * Reads the file's coordinate system as the text the writer stored.
 *
 * Deliberately returns a string rather than a parsed CRS: Decision 6 extracts
 * only the EPSG code and looks it up, because handing whole WKT to proj4 goes
 * quietly wrong on compound systems and dialects. Interpreting this belongs to
 * the CRS module.
 */
export async function readWkt(
  reader: RangeReader,
  header: Las.Header,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const offset = header.headerLength;
  const length = header.pointDataOffset - offset;
  if (length <= 0) {
    return absentWkt(reader, header);
  }

  const { bytes } = await reader.read({ offset, length }, signal);
  const region = new Uint8Array(bytes);

  // `walk` wants a getter; give it one over bytes already in hand so it makes
  // no requests of its own. evlrCount is zeroed because extended records live
  // near EOF, outside this region — absentWkt handles that case.
  const get = (begin: number, end: number): Promise<Uint8Array> =>
    Promise.resolve(region.subarray(begin - offset, end - offset));

  // A vlrCount larger than the region actually holds makes the walk parse a
  // short buffer as a record header, which copc.js reports as a bare Error
  // naming no file. The defect is in the file's own description of its VLR
  // region, so it fails as one (Decision 6).
  let vlrs: Las.Vlr[];
  try {
    vlrs = await Las.Vlr.walk(get, {
      headerLength: header.headerLength,
      vlrCount: header.vlrCount,
      evlrOffset: 0,
      evlrCount: 0,
    });
  } catch (cause) {
    throw new NotCopcError(reader.url, 'its VLR region does not hold the records it declares', {
      cause,
    });
  }

  const record = Las.Vlr.find(vlrs, WKT_USER_ID, WKT_RECORD_ID);
  if (record === undefined) {
    return absentWkt(reader, header);
  }

  const start = record.contentOffset - offset;
  const end = start + record.contentLength;
  // subarray would clamp here, handing the CRS module a truncated WKT that
  // simply will not yield an EPSG code — a confusing failure two modules away
  // from the file that caused it.
  if (end > region.length) {
    throw new NotCopcError(
      reader.url,
      `its WKT record declares ${record.contentLength} bytes, but only ` +
        `${region.length - start} remain in the VLR region`,
    );
  }
  const text = new TextDecoder().decode(region.subarray(start, end));

  // LAS 1.4 calls for null termination, and writers pad past it. A record that
  // trims away to nothing is a missing record, so it takes the same route as one
  // that was never written — absentWkt, not a bare undefined.
  const trimmed = text.replace(/\0+$/, '');
  return trimmed === '' ? absentWkt(reader, header) : trimmed;
}

/**
 * Decides what "no WKT in the VLR region" means for this file.
 *
 * An extended VLR could hold one, and this module does not read that region.
 * Returning undefined there would surface later as a confusing CRS failure
 * about a file that does declare a coordinate system.
 */
function absentWkt(reader: RangeReader, header: Las.Header): undefined {
  if (header.evlrCount > 0) {
    throw new WktNotInVlrsError(reader.url);
  }
  return undefined;
}
