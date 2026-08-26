// Regenerates the pinned COPC fixtures from two public COPC files.
//
// Run by hand, never by CI (CLAUDE.md: CI never touches the network). The
// cut slices are committed; this script exists so their provenance is
// reproducible rather than folklore.
//
// Two sources, because point format is the one property no single file can
// cover: COPC allows 6, 7 and 8, and a file is exactly one of them. Autzen is
// format 7 and carries colour; SoFi is format 6 and carries none, which is
// the branch `src/worker/pnts.ts` takes when it omits the RGB section.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Las, Info, Hierarchy } from 'copc';

const OUT = new URL('./', import.meta.url);

/** The digest the tests pin, so a length-preserving replacement fails loudly. */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * A verified Range reader bound to one source, so a server that ignores Range
 * cannot corrupt a fixture. The HEAD runs before any read, so `total` is
 * known when the first `Content-Range` is checked against it.
 */
async function openSource(url) {
  const head = await fetch(url, { method: 'HEAD' });
  const total = Number(head.headers.get('content-length'));
  const etag = head.headers.get('etag');
  const range = async (offset, length) => {
    const last = offset + length - 1;
    const response = await fetch(url, { headers: { range: `bytes=${offset}-${last}` } });
    if (response.status !== 206) throw new Error(`expected 206, got ${response.status}`);
    const contentRange = response.headers.get('content-range');
    if (contentRange !== `bytes ${offset}-${last}/${total}`) {
      throw new Error(`unexpected Content-Range: ${contentRange}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return { url, total, etag, range };
}

const SOURCE = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const { total: TOTAL, etag, range } = await openSource(SOURCE);

// Decision 4's first read: the LAS header plus the COPC info VLR, which the
// format fixes at offset 375, in a single request.
const first = await range(0, 589);
const header = Las.Header.parse(first.slice(0, 375));
if (header.headerLength !== 375) throw new Error(`headerLength ${header.headerLength}, expected 375`);
// The info VLR's 54-byte header sits at 375, its 160-byte payload at 429.
const info = Info.parse(first.slice(429, 589));

await mkdir(OUT, { recursive: true });
await writeFile(new URL('autzen-head.bin', OUT), first);

const vlrRegion = await range(header.headerLength, header.pointDataOffset - header.headerLength);
await writeFile(new URL('autzen-vlrs.bin', OUT), vlrRegion);

const { pageOffset, pageLength } = info.rootHierarchyPage;
const rootPage = await range(pageOffset, pageLength);
await writeFile(new URL('autzen-root-hierarchy.bin', OUT), rootPage);
const subtree = Hierarchy.parse(rootPage);

// The file's smallest node (by both point count and byte length), so its
// decoded numbers can be checked by hand against the compressed bytes.
// Found from the parsed page rather than hardcoded, so a re-cut against a
// changed source fails loudly (wrong key below) instead of silently cutting
// the wrong bytes under the old name.
const [smallestKey, smallestEntry] = Object.entries(subtree.nodes)
  .filter(([, node]) => node !== undefined && node.pointCount > 0)
  .sort(([, a], [, b]) => a.pointDataLength - b.pointDataLength)[0];
if (smallestKey !== '5-16-3-1') {
  throw new Error(`expected smallest node 5-16-3-1, got ${smallestKey}`);
}
const smallest = { offset: smallestEntry.pointDataOffset, length: smallestEntry.pointDataLength };
const smallestNode = await range(smallest.offset, smallest.length);
await writeFile(new URL('autzen-node-5-16-3-1.bin', OUT), smallestNode);

const provenance = {
  source: SOURCE,
  totalBytes: TOTAL,
  etag,
  cut: {
    'autzen-head.bin': {
      offset: 0,
      length: 589,
      sha256: sha256(first),
      why: "Decision 4's first read: LAS header + COPC info VLR",
    },
    'autzen-vlrs.bin': {
      offset: header.headerLength,
      length: header.pointDataOffset - header.headerLength,
      sha256: sha256(vlrRegion),
      why: 'the VLR region, where the WKT record lives',
    },
    'autzen-root-hierarchy.bin': {
      offset: pageOffset,
      length: pageLength,
      sha256: sha256(rootPage),
      why: 'the root hierarchy page',
    },
    'autzen-node-5-16-3-1.bin': {
      offset: smallest.offset,
      length: smallest.length,
      sha256: sha256(smallestNode),
      why: "node 5-16-3-1, the file's smallest, for decode fixtures checkable by hand",
    },
  },
  observed: {
    headerLength: header.headerLength,
    pointDataOffset: header.pointDataOffset,
    vlrCount: header.vlrCount,
    pointDataRecordFormat: header.pointDataRecordFormat,
    pointCount: header.pointCount,
    cube: info.cube,
    spacing: info.spacing,
    rootHierarchyPage: info.rootHierarchyPage,
    nodeCount: Object.keys(subtree.nodes).length,
    subPageCount: Object.keys(subtree.pages).length,
  },
};
// --- The format-6 source: header and one chunk, nothing else. ---
//
// Only the two slices a decode needs. The hierarchy page is deliberately not
// cut: SoFi's is 86 KB against Autzen's 8.7 KB, and nothing about format 6
// lives in a hierarchy page — the node's offset and point count are recorded
// below instead, which is all a test needs once the bytes are pinned.
const SOURCE6 = 'https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz';
const sofi = await openSource(SOURCE6);

const first6 = await sofi.range(0, 589);
const header6 = Las.Header.parse(first6.slice(0, 375));
if (header6.pointDataRecordFormat !== 6) {
  throw new Error(`expected point format 6, got ${header6.pointDataRecordFormat}`);
}
const info6 = Info.parse(first6.slice(429, 589));
await writeFile(new URL('sofi-head.bin', OUT), first6);

const rootPage6 = await sofi.range(
  info6.rootHierarchyPage.pageOffset,
  info6.rootHierarchyPage.pageLength,
);
const subtree6 = Hierarchy.parse(rootPage6);
const [smallestKey6, smallestEntry6] = Object.entries(subtree6.nodes)
  .filter(([, node]) => node !== undefined && node.pointCount > 0)
  .sort(([, a], [, b]) => a.pointDataLength - b.pointDataLength)[0];
if (smallestKey6 !== '6-23-29-3') {
  throw new Error(`expected smallest node 6-23-29-3, got ${smallestKey6}`);
}
const smallestNode6 = await sofi.range(
  smallestEntry6.pointDataOffset,
  smallestEntry6.pointDataLength,
);
await writeFile(new URL('sofi-node-6-23-29-3.bin', OUT), smallestNode6);

const provenance6 = {
  source: SOURCE6,
  totalBytes: sofi.total,
  etag: sofi.etag,
  cut: {
    'sofi-head.bin': {
      offset: 0,
      length: 589,
      sha256: sha256(first6),
      why: "Decision 4's first read: LAS header + COPC info VLR",
    },
    'sofi-node-6-23-29-3.bin': {
      offset: smallestEntry6.pointDataOffset,
      length: smallestEntry6.pointDataLength,
      sha256: sha256(smallestNode6),
      why: "node 6-23-29-3, the file's smallest, for a format-6 decode fixture",
    },
  },
  observed: {
    headerLength: header6.headerLength,
    pointDataOffset: header6.pointDataOffset,
    pointDataRecordFormat: header6.pointDataRecordFormat,
    pointDataRecordLength: header6.pointDataRecordLength,
    pointCount: header6.pointCount,
    scale: header6.scale,
    offset: header6.offset,
    smallestNode: { key: smallestKey6, pointCount: smallestEntry6.pointCount },
  },
};

await writeFile(
  new URL('provenance.json', OUT),
  JSON.stringify({ sources: [provenance, provenance6] }, null, 2) + '\n',
);
console.log(JSON.stringify(provenance.observed, null, 2));
console.log(JSON.stringify(provenance6.observed, null, 2));
