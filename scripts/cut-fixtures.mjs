// Regenerates the pinned COPC fixtures from the public Autzen file.
//
// Run by hand, never by CI (CLAUDE.md: CI never touches the network). The
// cut slices are committed; this script exists so their provenance is
// reproducible rather than folklore.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Las, Info, Hierarchy } from 'copc';

const SOURCE = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const OUT = new URL('../fixtures/', import.meta.url);

// Read before range() is defined, so TOTAL is initialised no matter when the
// first call happens. Reading it from inside the function while it was still
// in its temporal dead zone was safe only by accident of call order.
const head = await fetch(SOURCE, { method: 'HEAD' });
const TOTAL = Number(head.headers.get('content-length'));
const etag = head.headers.get('etag');

/** One verified Range read, so a server that ignores Range cannot corrupt a fixture. */
async function range(offset, length) {
  const last = offset + length - 1;
  const response = await fetch(SOURCE, { headers: { range: `bytes=${offset}-${last}` } });
  if (response.status !== 206) throw new Error(`expected 206, got ${response.status}`);
  const contentRange = response.headers.get('content-range');
  if (contentRange !== `bytes ${offset}-${last}/${TOTAL}`) {
    throw new Error(`unexpected Content-Range: ${contentRange}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The digest the tests pin, so a length-preserving replacement fails loudly. */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
await writeFile(new URL('provenance.json', OUT), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance.observed, null, 2));
