import { Info, Las } from 'copc';
import { NotCopcError, UnsupportedHeaderLayoutError } from '../errors/index.js';
import type { RangeReader } from '../range/index.js';

// COPC fixes the LAS header at 375 bytes and puts its own info VLR immediately
// after, so one 589-byte read covers the header, that record's 54-byte header,
// and its 160-byte payload. Decision 4 specifies exactly this range as the
// first request, which is why these are constants rather than arithmetic.
const HEADER_LENGTH = 375;
const INFO_VLR_HEADER_END = 429;
const INFO_VLR_CONTENT_LENGTH = 160;
const FIRST_READ_LENGTH = 589;

export interface CopcFileHeader {
  readonly header: Las.Header;
  readonly info: Info;
  /** The file's total size, when the server disclosed it in Content-Range. */
  readonly totalBytes: number | null;
}

/**
 * Reads everything the first request is allowed to see.
 *
 * Three things have to be true before the bytes mean anything: the file is LAS,
 * its header is the length COPC fixes, and the record at 375 really is the COPC
 * info VLR. Each failure is its own typed error, because each has a different fix.
 */
export async function readFileHeader(
  reader: RangeReader,
  signal?: AbortSignal,
): Promise<CopcFileHeader> {
  const { bytes, totalBytes } = await reader.read({ offset: 0, length: FIRST_READ_LENGTH }, signal);
  const first = new Uint8Array(bytes);

  let header: Las.Header;
  try {
    header = Las.Header.parse(first.subarray(0, HEADER_LENGTH));
  } catch (cause) {
    throw new NotCopcError(reader.url, 'the LAS header could not be read', { cause });
  }

  if (header.headerLength !== HEADER_LENGTH) {
    throw new UnsupportedHeaderLayoutError(reader.url, header.headerLength);
  }

  const infoVlr = Las.Vlr.parse(first.subarray(HEADER_LENGTH, INFO_VLR_HEADER_END));
  if (infoVlr.userId !== 'copc' || infoVlr.recordId !== 1) {
    throw new NotCopcError(
      reader.url,
      `the record at byte ${HEADER_LENGTH} is ${infoVlr.userId}/${infoVlr.recordId}, not copc/1`,
    );
  }

  // The record identifies itself as the info VLR, but only its declared length
  // proves the 160 bytes after it are the info payload. A different length means
  // bytes 429-588 belong to something else, and parsing them anyway yields a
  // plausible cube and spacing that are wrong — a silent failure as bad geometry
  // rather than a loud one as a bad file.
  if (infoVlr.contentLength !== INFO_VLR_CONTENT_LENGTH) {
    throw new NotCopcError(
      reader.url,
      `its copc/1 record declares ${infoVlr.contentLength} content bytes, not ` +
        `the ${INFO_VLR_CONTENT_LENGTH} the COPC info VLR has`,
    );
  }

  let info: Info;
  try {
    info = Info.parse(first.subarray(INFO_VLR_HEADER_END, FIRST_READ_LENGTH));
  } catch (cause) {
    // copc.js refuses a root hierarchy page whose offset or length exceeds
    // MAX_SAFE_INTEGER, with a bare Error naming no file. This sequence exists
    // to prove the file is COPC before anything else runs, so its failures
    // belong to that verdict (Decision 6).
    throw new NotCopcError(reader.url, 'its COPC info record could not be read', { cause });
  }

  return { header, info, totalBytes };
}
