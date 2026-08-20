import type { Info, Las } from 'copc';
import type { RangeReader } from '../range/index.js';
import { readFileHeader } from './header.js';
import type { HierarchyPage } from './hierarchy.js';
import { readHierarchyPage } from './hierarchy.js';
import { readWkt } from './wkt.js';

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
  const wkt = await readWkt(reader, header, signal);
  // The one place `copc.js`'s pageOffset/pageLength spelling is translated into
  // the library's own ByteRange, so nothing downstream has to know about it.
  const root = await readHierarchyPage(
    reader,
    { offset: info.rootHierarchyPage.pageOffset, length: info.rootHierarchyPage.pageLength },
    signal,
  );

  return { header, info, wkt, totalBytes, root };
}
