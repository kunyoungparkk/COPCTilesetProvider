import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { encodeHierarchyPage as buildPage } from './hierarchy-page.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const ROOT = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/autzen-root-hierarchy.bin', import.meta.url))),
);
const ROOT_PAGE = { offset: 81_114_146, length: 8896 };

/** Autzen's own header count, read from `fixtures/autzen-head.bin` (uint64 at 247). */
const AUTZEN_POINTS = 10_653_336;

// Bound for the constructed pages below, whose entries are small by
// construction. Only the tests that are about the bound itself pass their own.
const FILE_POINTS = 1_000_000;

function pageReader(page: Uint8Array, at: number) {
  const reads: ByteRange[] = [];
  const reader: RangeReader = {
    url: 'https://host/autzen.copc.laz',
    read: (range) => {
      reads.push(range);
      const start = range.offset - at;
      return Promise.resolve({
        bytes: page.slice(start, start + range.length).buffer as ArrayBuffer,
        totalBytes: 81_123_042,
      });
    },
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
  return { reader, reads };
}

describe('readHierarchyPage against the pinned root page', () => {
  it('reads exactly the range the info VLR reported', async () => {
    const { reader, reads } = pageReader(ROOT, ROOT_PAGE.offset);

    await readHierarchyPage(reader, ROOT_PAGE, AUTZEN_POINTS);

    expect(reads).toEqual([{ offset: 81_114_146, length: 8896 }]);
  });

  it('finds every node Autzen puts in its root page', async () => {
    const { reader } = pageReader(ROOT, ROOT_PAGE.offset);

    const { nodes, pages } = await readHierarchyPage(reader, ROOT_PAGE, AUTZEN_POINTS);

    expect(nodes).toHaveLength(278);
    // Autzen's whole hierarchy fits in one page, which is why the sub-page
    // path below is covered synthetically instead.
    expect(pages).toEqual([]);
  });

  it('describes the root node with byte-range vocabulary', async () => {
    const { reader } = pageReader(ROOT, ROOT_PAGE.offset);

    const { nodes } = await readHierarchyPage(reader, ROOT_PAGE, AUTZEN_POINTS);
    const root = nodes.find((node) => node.key.depth === 0);

    expect(root?.key).toEqual({ depth: 0, x: 0, y: 0, z: 0 });
    expect(root?.pointCount).toBeGreaterThan(0);
    expect(root?.length).toBeGreaterThan(0);
  });

  it('passes an abort signal straight through to the reader', async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new Error('should not resolve'));
    const reader = { url: 'https://host/autzen.copc.laz', read } as unknown as RangeReader;

    await expect(readHierarchyPage(reader, ROOT_PAGE, AUTZEN_POINTS, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledWith({ offset: 81_114_146, length: 8896 }, controller.signal);
  });
});

describe('readHierarchyPage against synthetic pages', () => {
  it('separates sub-page pointers from nodes', async () => {
    // A negative pointCount marks an entry that points at another page.
    const page = buildPage([
      { key: [0, 0, 0, 0], offset: 1000, byteSize: 200, pointCount: 50 },
      { key: [1, 0, 0, 0], offset: 5000, byteSize: 320, pointCount: -1 },
    ]);
    const { reader } = pageReader(page, 0);

    const { nodes, pages } = await readHierarchyPage(
      reader,
      { offset: 0, length: page.length },
      FILE_POINTS,
    );

    expect(nodes).toEqual([
      { key: { depth: 0, x: 0, y: 0, z: 0 }, offset: 1000, length: 200, pointCount: 50 },
    ]);
    expect(pages).toEqual([{ key: { depth: 1, x: 0, y: 0, z: 0 }, offset: 5000, length: 320 }]);
  });

  // Decision 6 makes the tileset omit content for these rather than encode a
  // zero-point tile. This module reports them honestly and decides nothing.
  // offset: 0 alongside byteSize: 0 is the spec-conformant shape for a
  // zero-point entry, not just an arbitrary zero byteSize.
  it('keeps an empty node rather than dropping it', async () => {
    const page = buildPage([{ key: [2, 1, 1, 0], offset: 0, byteSize: 0, pointCount: 0 }]);
    const { reader } = pageReader(page, 0);

    const { nodes } = await readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    expect(nodes).toEqual([
      { key: { depth: 2, x: 1, y: 1, z: 0 }, offset: 0, length: 0, pointCount: 0 },
    ]);
  });

  // One direction of the spec's rule: pointCount > 0 implies length > 0. Left
  // unchecked, this entry becomes a NodeDescriptor with a byte range nobody
  // can request, and dies one layer down in formatRangeHeader as
  // InvalidByteRangeError — blaming how the request was built for a defect
  // that is in the file, exactly what checkedLength's own comment says must
  // not happen.
  it('refuses a node that claims points but no bytes', async () => {
    const page = buildPage([{ key: [4, 1, 2, 3], offset: 4096, byteSize: 0, pointCount: 5 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('4-1-2-3');
    await expect(failure).rejects.toThrow('declares 5 points');
  });

  // The other direction. The COPC specification documents `Entry::byteSize` as
  // "0 if the pointCount is 0" (copc.io, hierarchy VLR section), so bytes
  // reserved for a node that holds nothing is the file contradicting itself.
  // Nothing downstream would notice: Decision 6 omits content for every
  // zero-point node whatever its length says, so these bytes are silently
  // dropped rather than read, and whatever the file meant to put there never
  // reaches anyone.
  it('refuses a node that declares no points but reserves bytes', async () => {
    const page = buildPage([{ key: [3, 0, 1, 1], offset: 2048, byteSize: 500, pointCount: 0 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('3-0-1-1');
    await expect(failure).rejects.toThrow('500');
  });

  // A node's points are a subset of the file's, so the header's own count is
  // an upper bound the file already carries. Unbounded, this field is what
  // decideChunk's laz-perf call allocates from: measured on the 951-byte
  // 47-point chunk fixture, a claim of 1_000_000 fabricates a million points
  // in about half a second, and copc.js reads the field as Int32 so a page can
  // ask for 2_147_483_647. Refusing it here blames the file, one layer above
  // the RangeError a dependency would otherwise throw.
  it('refuses a node that claims more points than the file holds', async () => {
    const page = buildPage([{ key: [2, 1, 0, 1], offset: 4096, byteSize: 512, pointCount: 1001 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, 1000);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('2-1-0-1');
    await expect(failure).rejects.toThrow('1001');
    await expect(failure).rejects.toThrow('1000');
  });

  // The bound is the file's count, not one less: a single-node octree holds
  // every point the file has. Off by one here would refuse a conformant file.
  it('admits a node holding every point the file has', async () => {
    const page = buildPage([{ key: [0, 0, 0, 0], offset: 4096, byteSize: 512, pointCount: 1000 }]);
    const { reader } = pageReader(page, 0);

    const { nodes } = await readHierarchyPage(reader, { offset: 0, length: page.length }, 1000);

    expect(nodes[0]?.pointCount).toBe(1000);
  });

  it('reads a deep key on every axis', async () => {
    const page = buildPage([{ key: [7, 96, 41, 12], offset: 10, byteSize: 20, pointCount: 30 }]);
    const { reader } = pageReader(page, 0);

    const { nodes } = await readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    expect(nodes[0]?.key).toEqual({ depth: 7, x: 96, y: 41, z: 12 });
  });

  it('reports an empty page as no nodes rather than failing', async () => {
    const { reader } = pageReader(new Uint8Array(0), 0);

    expect(await readHierarchyPage(reader, { offset: 0, length: 0 }, FILE_POINTS)).toEqual({
      nodes: [],
      pages: [],
    });
  });

  // The real reader rejects a zero-length range as a caller bug
  // (InvalidByteRangeError), so the case above reaches its answer only because
  // no request goes out at all.
  it('asks for nothing when the page is empty', async () => {
    const { reader, reads } = pageReader(new Uint8Array(0), 0);

    await readHierarchyPage(reader, { offset: 0, length: 0 }, FILE_POINTS);

    expect(reads).toEqual([]);
  });

  // A page is a whole number of 32-byte entries, so a truncated or padded one
  // is the likeliest corruption in the field. copc.js reports it with a bare
  // Error carrying no code and naming no file, which Decision 6 does not allow
  // to reach a caller.
  it('reports a page that is not a whole number of entries', async () => {
    const { reader } = pageReader(new Uint8Array(31), 0);

    const error = await readHierarchyPage(reader, { offset: 0, length: 31 }, FILE_POINTS).then(
      () => undefined,
      (thrown: Error) => thrown,
    );

    expect(error).toMatchObject({ code: 'malformed-hierarchy' });
    expect(error?.message).toContain('https://host/autzen.copc.laz');
    // copc.js's own complaint rides along as `cause` rather than being
    // paraphrased into our message, which would drift when its wording changes.
    expect(error?.cause).toBeInstanceOf(Error);
    expect(String(error?.cause)).toContain('Invalid hierarchy page length');
  });

  // pointCount below -1 is the other value copc.js refuses: -1 already means
  // "sub-page", so anything lower addresses nothing.
  it('reports an entry whose point count is below the sub-page marker', async () => {
    const page = buildPage([{ key: [0, 0, 0, 0], offset: 100, byteSize: 10, pointCount: -2 }]);
    const { reader } = pageReader(page, 0);

    const error = await readHierarchyPage(
      reader,
      { offset: 0, length: page.length },
      FILE_POINTS,
    ).then(
      () => undefined,
      (thrown: Error) => thrown,
    );

    expect(error).toMatchObject({ code: 'malformed-hierarchy' });
    expect(error?.cause).toBeInstanceOf(Error);
    expect(String(error?.cause)).toContain('Invalid hierarchy point count');
  });

  // copc.js joins the four key fields with '-', so a negative one — the only
  // way a corrupt page can produce an unparseable key — collides with that
  // separator. Building descriptors from a key we cannot read would put
  // nonsense octree addresses into the tileset.
  it('refuses a page whose keys are not octree addresses', async () => {
    const page = buildPage([{ key: [1, -2, 3, 4], offset: 100, byteSize: 10, pointCount: 5 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    // Decision 6: a page holds hundreds of entries, so naming the one that
    // failed is the difference between an actionable message and a shrug.
    await expect(failure).rejects.toThrow('1--2-3-4');
    // The url reaches the error from the reader rather than from a literal,
    // which nothing else on this path would catch.
    await expect(failure).rejects.toThrow('https://host/autzen.copc.laz');
  });

  // The length field is a signed Int32, so a corrupt page can declare a
  // negative one. Passed on, it reaches formatRangeHeader, which refuses it as
  // an InvalidByteRangeError — an error whose message blames how the request
  // was built for something only the file can be at fault for.
  it('refuses a node whose byte length is negative', async () => {
    const page = buildPage([{ key: [3, 1, 2, 0], offset: 100, byteSize: -8, pointCount: 5 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('3-1-2-0');
  });

  // Sub-page pointers take the same field from the same bytes, and reach the
  // reader by the same route once expansion reads them.
  it('refuses a sub-page whose byte length is negative', async () => {
    const page = buildPage([{ key: [1, 0, 1, 0], offset: 5000, byteSize: -1, pointCount: -1 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('1-0-1-0');
  });

  // The milder sibling of the points-but-no-bytes node defect: a page-pointer
  // entry claims "there is a child page here" the same way a node with
  // pointCount > 0 claims "there is point data here," and a zero-byte page
  // could not hold whatever the pointer claims exists. Left unrefused, a
  // future caller re-reading this descriptor would reach the zero-length
  // early return above and get nothing back — sub-page expansion (the caller
  // that would do that re-read) is not built in this codebase yet.
  it('refuses a sub-page that declares a byte length of zero', async () => {
    const page = buildPage([{ key: [1, 0, 1, 0], offset: 5000, byteSize: 0, pointCount: -1 }]);
    const { reader } = pageReader(page, 0);

    const failure = readHierarchyPage(reader, { offset: 0, length: page.length }, FILE_POINTS);

    await expect(failure).rejects.toMatchObject({ code: 'malformed-hierarchy' });
    await expect(failure).rejects.toThrow('1-0-1-0');
    await expect(failure).rejects.toThrow('points at a page');
  });
});

// The reason the descriptors spell their fields `offset`/`length`: sub-page
// expansion feeds this function's own output straight back into the reader and
// into this function. Anything else would make every consumer transliterate.
describe('descriptors as byte ranges', () => {
  it('feeds its own output back in without translating it', async () => {
    // Entry 0 points at a sub-page that occupies the next 32 bytes, so both
    // reads below are served by the same buffer.
    const page = buildPage([
      { key: [0, 0, 0, 0], offset: 32, byteSize: 32, pointCount: -1 },
      { key: [1, 0, 0, 0], offset: 900, byteSize: 64, pointCount: 7 },
    ]);
    const { reader } = pageReader(page, 0);

    const [sub] = (await readHierarchyPage(reader, { offset: 0, length: 32 }, FILE_POINTS)).pages;
    if (sub === undefined) {
      throw new Error('the page under test declares one sub-page');
    }

    // A PageDescriptor where a ByteRange is expected, with no field renaming.
    const { nodes } = await readHierarchyPage(reader, sub, FILE_POINTS);
    expect(nodes).toHaveLength(1);

    // And a NodeDescriptor[] where readonly ByteRange[] is expected, which is
    // exactly the call sub-project 5 makes.
    const asked: ByteRange[] = [];
    const collecting: RangeReader = {
      ...reader,
      readMany: (requests) => {
        asked.push(...requests);
        return Promise.resolve([]);
      },
    };
    await collecting.readMany(nodes);

    expect(asked).toEqual([
      { key: { depth: 1, x: 0, y: 0, z: 0 }, offset: 900, length: 64, pointCount: 7 },
    ]);
  });
});
