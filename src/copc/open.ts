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
 * and on nothing else, though, so Decision 4 would permit them concurrently —
 * sequencing them saves nothing and costs a round trip on every open, which is
 * on `fromUrl`'s critical path. Concurrency is also the only saving available
 * here: the VLR region sits near the start and the root page near EOF, 81 MB
 * apart in Autzen, so coalescing can never merge them. They stay sequential
 * because §7 takes a latency change from measurement in a fixed environment
 * rather than from reasoning, and nobody has measured this one — it is worth
 * doing in whichever sub-project owns `fromUrl` latency.
 *
 * No test pins that order, deliberately: sequential is a default we want
 * revisited with numbers, not behaviour someone would be wrong to break.
 */
export async function openCopc(reader: RangeReader, signal?: AbortSignal): Promise<CopcFile> {
  const { header, info, totalBytes } = await readFileHeader(reader, signal);

  if (!COPC_POINT_FORMATS.has(header.pointDataRecordFormat)) {
    throw new UnsupportedPointFormatError(reader.url, header.pointDataRecordFormat);
  }

  const wkt = await readWkt(reader, header, signal);

  // The COPC spec requires the hierarchy VLR to exist and to "always consist
  // of at least ONE hierarchy page" (copc.io, hierarchy VLR section) — an
  // empty octree already has an encoding, one entry with pointCount 0, so no
  // conformant file needs a zero-byte root page. Left unchecked, this reaches
  // readHierarchyPage's own zero-length early return (there for a different
  // reason: a zero-length ByteRange throws in formatRangeHeader) and opens
  // successfully with an empty root page instead of naming the file as the
  // defect's source.
  if (info.rootHierarchyPage.pageLength === 0) {
    throw new MalformedHierarchyError(
      reader.url,
      'its info VLR declares a root hierarchy page with a byte length of 0, but a ' +
        'conformant COPC file always has at least one hierarchy page',
    );
  }

  // The one place `copc.js`'s pageOffset/pageLength spelling is translated into
  // the library's own ByteRange, so nothing downstream has to know about it.
  const root = await readHierarchyPage(
    reader,
    { offset: info.rootHierarchyPage.pageOffset, length: info.rootHierarchyPage.pageLength },
    header.pointCount,
    signal,
  );

  return { header, info, wkt, totalBytes, root };
}
