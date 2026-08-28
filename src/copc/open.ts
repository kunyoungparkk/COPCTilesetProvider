import type { Info, Las } from 'copc';
import { MalformedHierarchyError, UnsupportedPointFormatError } from '../errors/index.js';
import type { RangeReader } from '../range/index.js';
import { readFileHeader } from './header.js';
import type { HierarchyPage } from './hierarchy.js';
import { readHierarchyPage } from './hierarchy.js';
import { readWkt } from './wkt.js';

// The three point data record formats COPC allows. Anything else is a plain
// LAS/LAZ file, which copc.js's extractor cannot read at all. Checked here,
// right after the header is parsed and before anything reads on, so such a
// file is refused once at open with the file named — not once per tile,
// inside a Worker, after the globe has already loaded.
//
// Format 6 is on this list and carries no colour; `src/worker/pnts.ts` omits
// the RGB section for it rather than refusing the file.
const COPC_POINT_FORMATS = new Set([6, 7, 8]);

export interface CopcFile {
  readonly header: Las.Header;
  readonly info: Info;
  /** The file's coordinate system as text. `undefined` when it declares none. */
  readonly wkt: string | undefined;
  readonly totalBytes: number | null;
  readonly root: HierarchyPage;
}

/**
 * Opens a COPC file: everything needed to build a tileset, and nothing else.
 *
 * OVERVIEW §4 limits this to metadata and the root hierarchy. Read 1 must come
 * first: the other two ranges are both taken from what it reported, and
 * Decision 4 allows no request built on a guess. Reads 2 and 3 depend on read 1
 * and on nothing else, so they run together — waiting for the VLR region before
 * asking for the root page spends a round trip to learn nothing, on the one
 * path `fromUrl` cannot return without.
 *
 * Concurrency is the only saving available here. The VLR region sits near the
 * start of the file and the root page near EOF — 81 MB apart in Autzen — so
 * coalescing them into one request could never be worth it, and the reader
 * `fromUrl` passes in is deliberately not the coalescing one.
 *
 * Running together means neither read may be left behind by the other. They
 * share a signal this function owns, aborted the moment either one fails: with
 * the root page known to be unreadable there is nothing left to do with a VLR
 * region, and waiting for it costs §7's whole deadline plus both retry waits —
 * around nineteen seconds — before a failure already known can be reported.
 *
 * `allSettled` rather than `all`, so which typed error a caller sees does not
 * depend on which read lost a race. Two failures that are genuinely the file's
 * are reported WKT-first, the order these had in sequence; a read this
 * function aborted is never the report, since all it says is that the other
 * one failed first.
 */
export async function openCopc(reader: RangeReader, signal?: AbortSignal): Promise<CopcFile> {
  const { header, info, totalBytes } = await readFileHeader(reader, signal);

  if (!COPC_POINT_FORMATS.has(header.pointDataRecordFormat)) {
    throw new UnsupportedPointFormatError(reader.url, header.pointDataRecordFormat);
  }

  // The COPC spec requires the hierarchy VLR to exist and to "always consist
  // of at least ONE hierarchy page" (copc.io, hierarchy VLR section) — an
  // empty octree already has an encoding, one entry with pointCount 0, so no
  // conformant file needs a zero-byte root page. Left unchecked, this reaches
  // readHierarchyPage's own zero-length early return (there for a different
  // reason: a zero-length ByteRange throws in formatRangeHeader) and opens
  // successfully with an empty root page instead of naming the file as the
  // defect's source.
  //
  // Checked before the reads below rather than after, so a file this refuses
  // still costs no request — the same reason `fromUrl` refuses a relative URL
  // before opening anything.
  if (info.rootHierarchyPage.pageLength === 0) {
    throw new MalformedHierarchyError(
      reader.url,
      'its info VLR declares a root hierarchy page with a byte length of 0, but a ' +
        'conformant COPC file always has at least one hierarchy page',
    );
  }

  // What one read is aborted with when the other has already failed. Built
  // per call so identity alone tells it apart from anything a reader could
  // raise, and an `Error` rather than a bare token so that a path nobody has
  // thought of still ends in something readable.
  const siblingFailed = new Error("openCopc: the other of this file's two reads failed first");

  // Reads 2 and 3 share this rather than the caller's own signal, so that
  // either one's failure can end the other. The caller's abort still reaches
  // both, forwarded below.
  const stop = new AbortController();
  const onCallerAbort = (): void => stop.abort(signal?.reason);
  if (signal?.aborted === true) {
    // An `abort` that has already fired never replays for a listener added
    // afterwards, so this case has to be forwarded by hand.
    stop.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', onCallerAbort, { once: true });
  }

  const wkt = readWkt(reader, header, stop.signal);
  // The one place `copc.js`'s pageOffset/pageLength spelling is translated
  // into the library's own ByteRange, so nothing downstream has to know
  // about it.
  const root = readHierarchyPage(
    reader,
    { offset: info.rootHierarchyPage.pageOffset, length: info.rootHierarchyPage.pageLength },
    header.pointCount,
    stop.signal,
  );
  for (const read of [wkt, root]) {
    // Nothing awaits these handlers, so they cannot reorder the settlement
    // below; they only bring the other read to an end early.
    void read.catch(() => stop.abort(siblingFailed));
  }

  let wktRead: PromiseSettledResult<string | undefined>;
  let rootRead: PromiseSettledResult<HierarchyPage>;
  try {
    [wktRead, rootRead] = await Promise.allSettled([wkt, root]);
  } finally {
    // A no-op when none was added, which is what makes the already-aborted
    // branch above safe to take.
    signal?.removeEventListener('abort', onCallerAbort);
  }

  if (wktRead.status === 'rejected') {
    // `siblingFailed` means this read was ended because the other one had
    // already failed, so the other one's reason is the answer.
    throw wktRead.reason === siblingFailed && rootRead.status === 'rejected'
      ? rootRead.reason
      : wktRead.reason;
  }
  if (rootRead.status === 'rejected') {
    throw rootRead.reason;
  }

  return { header, info, wkt: wktRead.value, totalBytes, root: rootRead.value };
}
