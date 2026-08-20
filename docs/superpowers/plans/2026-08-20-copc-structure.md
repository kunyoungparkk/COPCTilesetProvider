# COPC Structure Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a COPC file's own structure — the LAS header, the COPC info VLR, the WKT, and the hierarchy pages — into the node descriptors every module downstream works from, using only reads the spec allows.

**Architecture:** Four small functions over the verified Range reader, composed by one `openCopc`. Parsing is delegated to `copc.js`'s pure buffer parsers; the *reads* are ours, because `copc.js`'s own I/O layer breaks the spec (see below). Three requests open a file: the mandated first 589 bytes, the VLR region, and the root hierarchy page.

**Tech Stack:** TypeScript 7 (browser ESM), Vitest, `copc` (already an approved dependency).

**Spec:** `OVERVIEW.md` — §3 Decision 4 (the fixed first read, no speculative prefetch, every read verified), §3 Decision 6 (errors are API; CRS comes from the file's WKT), §4 (`fromUrl` reads metadata and root hierarchy only).

## Global Constraints

- Node 22 for all commands. This machine's default `node` is v18, so every command below assumes `export PATH=/home/kyp/.local/node22/bin:$PATH` first.
- No new runtime dependencies. OVERVIEW §5 fixes the set at `copc`, `laz-perf`, `proj4`; `tests/manifest.test.ts` fails the build if that changes.
- **Every read goes through `RangeReader`.** No `fetch`, no `Getter.http`, no `copc.js` function that takes a URL or filename.
- **No speculative prefetch.** Every request's offset and length comes from a value some earlier response reported.
- Error messages are public API (Decision 6): each names what failed and the change that fixes it. Codes never change.
- Comments explain *why*, and cite the OVERVIEW decision or section that forced the choice.
- Tests never touch the network. They read pinned bytes from `fixtures/`.
- Commits: `type(scope): summary`, imperative, **under 72 characters**, with a body explaining why. No `Co-Authored-By` or `Signed-off-by` trailers.

## Why we do not use `Copc.create`

`copc.js` exposes exactly what we need as pure functions over buffers — `Las.Header.parse`, `Las.Vlr.parse`, `Las.Vlr.walk`, `Info.parse`, `Hierarchy.parse` — and we use all of them. What we do **not** use is its I/O layer.

`Copc.create` opens a file by fetching bytes 0–65535 unconditionally, as an optimisation for walking VLRs without extra round trips. That is a 64 KiB blind read. It violates Decision 4 twice over: the first request is specified as bytes 0-588, and speculative prefetch is forbidden outright. `Hierarchy.load` is better behaved — it reads exactly one page — but routing through it would bypass `readMany`, and coalescing several hierarchy pages into one request is precisely what the previous sub-project built.

So: their parsers, our transport. Anything in `copc.js` that accepts a `string | Getter` is off limits.

## Decisions already settled

Agreed before this plan was written. Do not relitigate them mid-task; if one turns out to be wrong, stop and report.

- **`RangeReader` gains `readonly url: string`.** Errors need it, and threading a redundant parameter through four functions is worse than one field on an object that already belongs to exactly one URL.
- **WKT held in an EVLR is not read.** No file we know of does this, and reading the EVLR region means another request near EOF. If `evlrCount > 0` and no WKT VLR is found, fail with a typed error naming the situation and the fix, rather than returning `undefined` and letting the CRS module report a confusing second-order failure.
- **`copc.js`'s types are re-exported, not remapped.** `Las.Header` and `Info` are a direct dependency's types; wrapping them would be ceremony.
- **The root hierarchy page is read eagerly.** OVERVIEW §4 says `fromUrl` reads metadata *and* root hierarchy.
- **EPSG extraction is not this module's job.** `openCopc` surfaces the raw WKT string; the `crs` sub-project parses it. The anchor fixture makes the reason concrete: Autzen's WKT is a `COMPD_CS` — `"NAD83 / Oregon GIC Lambert (ft) + NAVD88 height (ftUS)"` — and a naive trailing-`AUTHORITY` match does not find its horizontal code. That is exactly the compound-CRS trap Decision 6 warns about, and it deserves its own sub-project rather than a regex here.

## What the anchor fixture already told us

The pinned Autzen slices are cut and committed (`fixtures/`, provenance in `fixtures/provenance.json`). Facts worth knowing before you write code against them:

| | |
|---|---|
| `headerLength` | 375 — the value Decision 4 requires |
| `pointDataOffset` | 1736, so the VLR region is 1361 bytes |
| VLRs | `copc/1` (160 bytes), `laszip encoded/22204`, `LASF_Projection/2112` (993 bytes) |
| `rootHierarchyPage` | offset 81 114 146, length 8896 — near EOF, after the point data |
| root page contents | **278 nodes, 0 sub-pages** |

That last row matters: Autzen's whole hierarchy fits in one page, so the real file cannot exercise lazy sub-page expansion at all. Synthetic fixtures carry that path, and the anchor proves the synthesiser is not fiction.

## File Structure

- `fixtures/` — the pinned Autzen slices plus `provenance.json`. Committed bytes; never fetched by tests.
- `scripts/cut-fixtures.mjs` — regenerates them from the public file. Run by hand, never by CI.
- `src/errors/copc.ts` — the structure errors. `src/errors/index.ts` re-exports.
- `src/copc/header.ts` — the mandated first read, the `headerLength` check, header and info parsing.
- `src/copc/wkt.ts` — the VLR-region read and WKT extraction.
- `src/copc/hierarchy.ts` — a page read, and the conversion into node and page descriptors.
- `src/copc/open.ts` — `openCopc`, which composes the three into one opened file.
- `src/copc/index.ts` — re-exports. The only path other modules import from.
- `tests/copc-fixtures.test.ts`, `tests/copc-header.test.ts`, `tests/copc-wkt.test.ts`, `tests/copc-hierarchy.test.ts`, `tests/copc-open.test.ts` — flat, matching the existing layout.

---

### Task 1: Pin the fixtures

The fixtures and the cutting script already exist in the working tree, uncommitted. This task commits them with a test that says what they are, so a corrupted or silently replaced fixture fails loudly instead of producing confusing parse errors three tasks later.

**Files:**
- Commit as-is: `fixtures/autzen-head.bin`, `fixtures/autzen-vlrs.bin`, `fixtures/autzen-root-hierarchy.bin`, `fixtures/provenance.json`, `scripts/cut-fixtures.mjs`
- Create: `fixtures/README.md`
- Test: `tests/copc-fixtures.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: three fixture files at known paths, and the shared understanding that tests read them with `readFileSync` from `fixtures/`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/copc-fixtures.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const provenance = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/provenance.json', import.meta.url)), 'utf8'),
) as {
  source: string;
  totalBytes: number;
  cut: Record<string, { offset: number; length: number }>;
};

// These bytes are the only real COPC file the suite ever sees. If one is
// replaced or truncated, every downstream test fails with a parse error that
// says nothing about why — so say it here instead.
describe('pinned Autzen fixtures', () => {
  it('records where each slice came from', () => {
    expect(provenance.source).toContain('autzen');
    expect(provenance.totalBytes).toBe(81_123_042);
  });

  it.each([
    ['autzen-head.bin', 589],
    ['autzen-vlrs.bin', 1361],
    ['autzen-root-hierarchy.bin', 8896],
  ])('%s is exactly %i bytes, as provenance says', (name, length) => {
    expect(fixture(name)).toHaveLength(length);
    expect(provenance.cut[name]?.length).toBe(length);
  });

  it('starts with the LAS file signature', () => {
    expect(new TextDecoder().decode(fixture('autzen-head.bin').subarray(0, 4))).toBe('LASF');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/copc-fixtures.test.ts`
Expected: PASS if the fixtures are already in the working tree. This test guards their content rather than driving new code, so a green first run is the correct outcome — confirm it is green *because* the files are right, by temporarily truncating one and watching the length assertion fail, then restoring it. Report that as the red-green evidence.

- [ ] **Step 3: Write the fixture README**

```markdown
# fixtures

Pinned byte slices from a real COPC file, plus synthetic layouts built in the
tests. Committed bytes only — the suite never fetches anything.

## The anchor

`autzen-*.bin` are cut from the public Autzen file recorded in
`provenance.json`. They exist so the synthetic fixtures cannot drift into
fiction: whatever we believe the format looks like has to also parse a file
somebody else wrote.

| file | what it is |
|---|---|
| `autzen-head.bin` | bytes 0-588 — the LAS header and the COPC info VLR, the single first read Decision 4 mandates |
| `autzen-vlrs.bin` | the VLR region, where the WKT record lives |
| `autzen-root-hierarchy.bin` | the root hierarchy page: 278 nodes, no sub-pages |

Autzen's root page has no sub-pages, so it cannot exercise lazy hierarchy
expansion. That path is covered by synthetic fixtures built in the tests.

Its WKT is a `COMPD_CS` — a compound horizontal-plus-vertical CRS — which is
the case OVERVIEW Decision 6 refuses to hand to proj4 whole.

## Regenerating

`node scripts/cut-fixtures.mjs` re-cuts them from the source URL. It needs the
network, so run it by hand; CI never does.
```

- [ ] **Step 4: Commit**

```bash
git add fixtures scripts/cut-fixtures.mjs tests/copc-fixtures.test.ts
git commit -m "test(copc): pin Autzen slices as the format anchor"
```

---

### Task 2: The first read

**Files:**
- Create: `src/errors/copc.ts`, `src/copc/header.ts`
- Modify: `src/errors/index.ts`, `src/range/range-reader.ts`
- Test: `tests/copc-header.test.ts`

**Interfaces:**
- Consumes: `RangeReader` from `src/range/index.js`; `Las`, `Info` from `copc`.
- Produces:
  - `RangeReader` gains `readonly url: string`.
  - `NotCopcError(url, detail)` with code `not-copc`; `UnsupportedHeaderLayoutError(url, headerLength)` with code `unsupported-header-layout`.
  - `interface CopcFileHeader { readonly header: Las.Header; readonly info: Info; readonly totalBytes: number | null }`
  - `readFileHeader(reader: RangeReader, signal?: AbortSignal): Promise<CopcFileHeader>`

> **The byte layout, once, so no task has to re-derive it:** the LAS header occupies 0-374. COPC fixes its info VLR immediately after, so that record's 54-byte header is at 375-428 and its 160-byte payload at 429-588. One read of 589 bytes covers all of it, which is why Decision 4 specifies exactly that range.

- [ ] **Step 1: Give the reader its URL**

In `src/range/range-reader.ts`, add to the `RangeReader` interface:

```ts
  /** The file this reader reads. Errors name it, and a reader serves exactly one. */
  readonly url: string;
```

and include it in the returned object: `return { url, read, readMany, stats };`

Run `npm test` — it should still pass, since nothing asserted the object's exact shape.

- [ ] **Step 2: Write the failing test**

```ts
// tests/copc-header.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readFileHeader } from '../src/copc/header.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const AUTZEN = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/autzen-head.bin', import.meta.url))),
);
const URL_ = 'https://host/autzen.copc.laz';

/** A reader that serves one buffer and records what was asked for. */
function bufferReader(bytes: Uint8Array, totalBytes: number | null = 81_123_042) {
  const reads: ByteRange[] = [];
  const reader: RangeReader = {
    url: URL_,
    read: (range) => {
      reads.push(range);
      return Promise.resolve({
        bytes: bytes.slice(range.offset, range.offset + range.length).buffer as ArrayBuffer,
        totalBytes,
      });
    },
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
  return { reader, reads };
}

describe('readFileHeader', () => {
  it('reads the header and the info VLR in the one range Decision 4 specifies', async () => {
    const { reader, reads } = bufferReader(AUTZEN);

    const result = await readFileHeader(reader);

    expect(reads).toEqual([{ offset: 0, length: 589 }]);
    expect(result.header.headerLength).toBe(375);
    expect(result.header.pointDataOffset).toBe(1736);
    expect(result.header.pointCount).toBe(10_653_336);
    expect(result.totalBytes).toBe(81_123_042);
  });

  it('parses the COPC info that sits at the fixed offset', async () => {
    const { reader } = bufferReader(AUTZEN);

    const { info } = await readFileHeader(reader);

    expect(info.rootHierarchyPage).toEqual({ pageOffset: 81_114_146, pageLength: 8896 });
    expect(info.spacing).toBeCloseTo(36.371, 3);
  });

  it('rejects a file that is not LAS at all', async () => {
    const notLas = new Uint8Array(AUTZEN);
    notLas.set(new TextEncoder().encode('JUNK'), 0);
    const { reader } = bufferReader(notLas);

    await expect(readFileHeader(reader)).rejects.toMatchObject({ code: 'not-copc' });
  });

  // Decision 4 reads the info VLR at 375 because the format fixes it there. A
  // different header length means that assumption is void, so the read that
  // just happened cannot be trusted — fail rather than parse garbage.
  it('rejects a header whose length is not 375', async () => {
    const shortHeader = new Uint8Array(AUTZEN);
    new DataView(shortHeader.buffer).setUint16(94, 227, true); // headerLength field
    const { reader } = bufferReader(shortHeader);

    await expect(readFileHeader(reader)).rejects.toMatchObject({
      code: 'unsupported-header-layout',
      headerLength: 227,
    });
  });

  it('rejects a LAS file with no COPC info VLR where the format requires one', async () => {
    const noInfo = new Uint8Array(AUTZEN);
    noInfo.set(new TextEncoder().encode('other'), 375 + 2); // the VLR's userId field
    const { reader } = bufferReader(noInfo);

    await expect(readFileHeader(reader)).rejects.toMatchObject({ code: 'not-copc' });
  });

  it('passes an abort signal straight through to the reader', async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new Error('should not resolve'));
    const reader = { url: URL_, read, readMany: vi.fn(), stats: vi.fn() } as unknown as RangeReader;

    await expect(readFileHeader(reader, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledWith({ offset: 0, length: 589 }, controller.signal);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run tests/copc-header.test.ts`
Expected: FAIL — cannot resolve `../src/copc/header.js`.

- [ ] **Step 4: Write the errors**

```ts
// src/errors/copc.ts
import { CopcTilesetError } from './base.js';

/** The bytes at the start of the file are not a COPC file. */
export class NotCopcError extends CopcTilesetError {
  readonly code = 'not-copc';
  readonly url: string;
  readonly detail: string;

  constructor(url: string, detail: string, options?: ErrorOptions) {
    super(
      `${url} is not a COPC file: ${detail}. This library reads Cloud Optimized ` +
        'Point Cloud files specifically — a plain LAS or LAZ file has to be converted ' +
        'first, for example with `pdal translate input.laz output.copc.laz`.',
      options,
    );
    this.url = url;
    this.detail = detail;
  }
}

/**
 * The LAS header is not the 375 bytes COPC fixes it at.
 *
 * Decision 4 reads the info VLR at offset 375 because the format guarantees it
 * is there. A different header length voids that guarantee, so continuing would
 * mean parsing whatever happens to sit at 375 as if it were the info record.
 */
export class UnsupportedHeaderLayoutError extends CopcTilesetError {
  readonly code = 'unsupported-header-layout';
  readonly url: string;
  readonly headerLength: number;

  constructor(url: string, headerLength: number) {
    super(
      `${url} declares a ${headerLength}-byte LAS header, but COPC fixes it at 375. ` +
        'The file is either not COPC or was written by a tool that does not follow the ' +
        'specification; re-writing it with a current PDAL will produce a conforming header.',
    );
    this.url = url;
    this.headerLength = headerLength;
  }
}
```

Add both to `src/errors/index.ts`, keeping the export list alphabetical.


- [ ] **Step 5: Write the reader**

```ts
// src/copc/header.ts
import { Info, Las } from 'copc';
import { NotCopcError, UnsupportedHeaderLayoutError } from '../errors/index.js';
import type { RangeReader } from '../range/index.js';

// COPC fixes the LAS header at 375 bytes and puts its own info VLR immediately
// after, so one 589-byte read covers the header, that record's 54-byte header,
// and its 160-byte payload. Decision 4 specifies exactly this range as the
// first request, which is why these are constants rather than arithmetic.
const HEADER_LENGTH = 375;
const INFO_VLR_HEADER_END = 429;
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

  const info = Info.parse(first.subarray(INFO_VLR_HEADER_END, FIRST_READ_LENGTH));
  return { header, info, totalBytes };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/errors src/copc/header.ts src/range/range-reader.ts tests/copc-header.test.ts
git commit -m "feat(copc): read the header and info in one verified range"
```

---

### Task 3: The WKT

**Files:**
- Create: `src/copc/wkt.ts`
- Modify: `src/errors/copc.ts`, `src/errors/index.ts`
- Test: `tests/copc-wkt.test.ts`

**Interfaces:**
- Consumes: Task 2's `RangeReader.url` and `Las.Header`.
- Produces: `WktNotInVlrsError(url)` with code `wkt-not-in-vlrs`; `readWkt(reader: RangeReader, header: Las.Header, signal?: AbortSignal): Promise<string | undefined>`, returning `undefined` when the file genuinely has no WKT and throwing `WktNotInVlrsError` when it has extended VLRs that might hold one.

This task creates the error it throws. Task 2 deliberately does not, because an
error no code raises and no test exercises is exactly the untested-export defect
this project's reviews keep catching. Append it to `src/errors/copc.ts`:

```ts
/** The WKT record is missing from the VLR region, and may be in an EVLR. */
export class WktNotInVlrsError extends CopcTilesetError {
  readonly code = 'wkt-not-in-vlrs';
  readonly url: string;

  constructor(url: string) {
    super(
      `${url} has no WKT record among its VLRs, but does declare extended VLRs, so its ` +
        'coordinate system is probably stored there. This library reads WKT from the VLR ' +
        'region only. Re-save the file with the WKT as a regular VLR — `pdal translate` ' +
        'does this by default — or open an issue if extended VLRs matter for your data.',
    );
    this.url = url;
  }
}
```

> **Why one read rather than `Las.Vlr.walk` over the network:** `walk` fetches each record's header separately. Given the real reader that is one round trip per VLR, which is the cost coalescing exists to remove. The header already told us where the VLR region starts and ends, so one request covers all of them, and `walk` runs against a getter backed by bytes we already hold.

- [ ] **Step 1: Write the failing test**

```ts
// tests/copc-wkt.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';
import { describe, expect, it } from 'vitest';
import { readWkt } from '../src/copc/wkt.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const HEAD = load('autzen-head.bin');
const VLRS = load('autzen-vlrs.bin');
const HEADER = Las.Header.parse(HEAD.subarray(0, 375));

/** Serves the VLR region at its real file offset, and nothing else. */
function vlrReader(region: Uint8Array = VLRS, header: Las.Header = HEADER) {
  const reads: ByteRange[] = [];
  const reader: RangeReader = {
    url: 'https://host/autzen.copc.laz',
    read: (range) => {
      reads.push(range);
      const start = range.offset - header.headerLength;
      return Promise.resolve({
        bytes: region.slice(start, start + range.length).buffer as ArrayBuffer,
        totalBytes: 81_123_042,
      });
    },
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
  return { reader, reads };
}

describe('readWkt', () => {
  it('reads the whole VLR region in one request', async () => {
    const { reader, reads } = vlrReader();

    await readWkt(reader, HEADER);

    // headerLength to pointDataOffset — both reported by the header we already read.
    expect(reads).toEqual([{ offset: 375, length: 1361 }]);
  });

  it('returns the WKT string as written, without interpreting it', async () => {
    const { reader } = vlrReader();

    const wkt = await readWkt(reader, HEADER);

    // Autzen's is a compound CRS. Decision 6 refuses to hand this to proj4
    // whole, which is why this module returns text and stops there.
    expect(wkt?.startsWith('COMPD_CS[')).toBe(true);
    expect(wkt).toContain('NAD83 / Oregon GIC Lambert (ft)');
    expect(wkt).not.toMatch(/\0/);
  });

  it('returns undefined when the file has no WKT and no extended VLRs', async () => {
    const header = { ...HEADER, vlrCount: 0, evlrCount: 0, pointDataOffset: 375 };
    const { reader } = vlrReader(new Uint8Array(0), header);

    expect(await readWkt(reader, header)).toBeUndefined();
  });

  // Silently reporting "no CRS" for a file that has one, stored somewhere we do
  // not look, would surface later as a confusing CRS failure.
  it('says so when the WKT might be in an extended VLR', async () => {
    const header = { ...HEADER, vlrCount: 0, evlrCount: 1, pointDataOffset: 375 };
    const { reader } = vlrReader(new Uint8Array(0), header);

    await expect(readWkt(reader, header)).rejects.toMatchObject({ code: 'wkt-not-in-vlrs' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/copc-wkt.test.ts`
Expected: FAIL — cannot resolve `../src/copc/wkt.js`.

- [ ] **Step 3: Write the reader**

```ts
// src/copc/wkt.ts
import { Las } from 'copc';
import { WktNotInVlrsError } from '../errors/index.js';
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

  const vlrs = await Las.Vlr.walk(get, {
    headerLength: header.headerLength,
    vlrCount: header.vlrCount,
    evlrOffset: 0,
    evlrCount: 0,
  });

  const record = Las.Vlr.find(vlrs, WKT_USER_ID, WKT_RECORD_ID);
  if (record === undefined) {
    return absentWkt(reader, header);
  }

  const start = record.contentOffset - offset;
  const text = new TextDecoder().decode(region.subarray(start, start + record.contentLength));

  // LAS 1.4 calls for null termination, and files exist with trailing padding.
  // A record that trims to nothing is a missing record, so it goes through the
  // same judgement — returning undefined here would skip the one check that
  // knows an extended VLR might hold the real thing.
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
```

> One read, and one place that decides what a missing record means. The test
> asserting a single request is what holds the first property; the second is
> why `absentWkt` exists rather than the check being written twice.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, including the single-read assertion.

- [ ] **Step 5: Commit**

```bash
git add src/copc/wkt.ts src/errors/copc.ts src/errors/index.ts tests/copc-wkt.test.ts
git commit -m "feat(copc): read the WKT record without interpreting it"
```

---

### Task 4: Hierarchy pages into descriptors

**Files:**
- Create: `src/copc/hierarchy.ts`
- Test: `tests/copc-hierarchy.test.ts`

**Interfaces:**
- Consumes: `RangeReader`; `Hierarchy` from `copc`.
- Produces:
  - `interface NodeKey { readonly depth: number; readonly x: number; readonly y: number; readonly z: number }`
  - `interface NodeDescriptor { readonly key: NodeKey; readonly offset: number; readonly length: number; readonly pointCount: number }`
  - `interface PageDescriptor { readonly key: NodeKey; readonly offset: number; readonly length: number }`
  - `interface HierarchyPage { readonly nodes: readonly NodeDescriptor[]; readonly pages: readonly PageDescriptor[] }`
  - `readHierarchyPage(reader: RangeReader, page: ByteRange, signal?: AbortSignal): Promise<HierarchyPage>`
  - `MalformedHierarchyError(url, detail, options?)` with code `malformed-hierarchy`, in `src/errors/copc.ts` and re-exported. It covers every way a page can be unreadable — a length that is not a multiple of 32, a point count below -1, a key that is not an octree address, and an entry whose byte length is negative — because all four are defects in the file, and the error must not blame the request that fetched it. `copc.js` reports the first two as bare `Error`s with no code and no file name, so they are wrapped with the original as `cause` rather than paraphrased; the message therefore may not claim the page's byte layout is valid.

> `copc.js` keys entries by the string `"depth-x-y-z"` and already splits an entry that points at a sub-page out of `nodes` into `pages`. Our job is the read, the key parsing, and renaming its fields to `offset`/`length` — the fields of `ByteRange` in `src/range/content-range.ts`, which is the library's byte-range type. Spelling them that way makes both descriptors assignable to `ByteRange`, so sub-page expansion hands this function's output straight back to `readMany` and to this function, with no translation. `copc.js`'s own `pageOffset`/`pageLength` spelling is converted once, in `openCopc`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/copc-hierarchy.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const ROOT = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../fixtures/autzen-root-hierarchy.bin', import.meta.url))),
);
const ROOT_PAGE = { offset: 81_114_146, length: 8896 };

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

/** Builds a page byte-for-byte: 32 bytes per entry, little-endian. */
function buildPage(
  entries: readonly { key: [number, number, number, number]; offset: number; byteSize: number; pointCount: number }[],
): Uint8Array {
  const bytes = new Uint8Array(entries.length * 32);
  const view = new DataView(bytes.buffer);
  entries.forEach((entry, index) => {
    const at = index * 32;
    const [depth, x, y, z] = entry.key;
    view.setInt32(at, depth, true);
    view.setInt32(at + 4, x, true);
    view.setInt32(at + 8, y, true);
    view.setInt32(at + 12, z, true);
    view.setBigInt64(at + 16, BigInt(entry.offset), true);
    view.setInt32(at + 24, entry.byteSize, true);
    view.setInt32(at + 28, entry.pointCount, true);
  });
  return bytes;
}

describe('readHierarchyPage against the pinned root page', () => {
  it('reads exactly the range the info VLR reported', async () => {
    const { reader, reads } = pageReader(ROOT, ROOT_PAGE.offset);

    await readHierarchyPage(reader, ROOT_PAGE);

    expect(reads).toEqual([{ offset: 81_114_146, length: 8896 }]);
  });

  it('finds every node Autzen puts in its root page', async () => {
    const { reader } = pageReader(ROOT, ROOT_PAGE.offset);

    const { nodes, pages } = await readHierarchyPage(reader, ROOT_PAGE);

    expect(nodes).toHaveLength(278);
    // Autzen's whole hierarchy fits in one page, which is why the sub-page
    // path below is covered synthetically instead.
    expect(pages).toEqual([]);
  });

  it('describes the root node with byte-range vocabulary', async () => {
    const { reader } = pageReader(ROOT, ROOT_PAGE.offset);

    const { nodes } = await readHierarchyPage(reader, ROOT_PAGE);
    const root = nodes.find((node) => node.key.depth === 0);

    expect(root?.key).toEqual({ depth: 0, x: 0, y: 0, z: 0 });
    expect(root?.pointCount).toBeGreaterThan(0);
    expect(root?.length).toBeGreaterThan(0);
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

    const { nodes, pages } = await readHierarchyPage(reader, { offset: 0, length: page.length });

    expect(nodes).toEqual([{ key: { depth: 0, x: 0, y: 0, z: 0 }, offset: 1000, length: 200, pointCount: 50 }]);
    expect(pages).toEqual([{ key: { depth: 1, x: 0, y: 0, z: 0 }, offset: 5000, length: 320 }]);
  });

  // Decision 6 makes the tileset omit content for these rather than encode a
  // zero-point tile. This module reports them honestly and decides nothing.
  it('keeps an empty node rather than dropping it', async () => {
    const page = buildPage([{ key: [2, 1, 1, 0], offset: 900, byteSize: 0, pointCount: 0 }]);
    const { reader } = pageReader(page, 0);

    const { nodes } = await readHierarchyPage(reader, { offset: 0, length: page.length });

    expect(nodes).toEqual([{ key: { depth: 2, x: 1, y: 1, z: 0 }, offset: 900, length: 0, pointCount: 0 }]);
  });

  it('reads a deep key on every axis', async () => {
    const page = buildPage([{ key: [7, 96, 41, 12], offset: 10, byteSize: 20, pointCount: 30 }]);
    const { reader } = pageReader(page, 0);

    const { nodes } = await readHierarchyPage(reader, { offset: 0, length: page.length });

    expect(nodes[0]?.key).toEqual({ depth: 7, x: 96, y: 41, z: 12 });
  });

  it('reports an empty page as no nodes rather than failing', async () => {
    const { reader } = pageReader(new Uint8Array(0), 0);

    expect(await readHierarchyPage(reader, { offset: 0, length: 0 })).toEqual({
      nodes: [],
      pages: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/copc-hierarchy.test.ts`
Expected: FAIL — cannot resolve `../src/copc/hierarchy.js`.

- [ ] **Step 3: Write the reader**

```ts
// src/copc/hierarchy.ts
import { Hierarchy } from 'copc';
import { MalformedHierarchyError } from '../errors/index.js';
import type { RangeReader } from '../range/index.js';

/** An octree address: depth, then the cell's index on each axis at that depth. */
export interface NodeKey {
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A node's compressed point data, as a byte range in the file. */
export interface NodeDescriptor {
  readonly key: NodeKey;
  readonly offset: number;
  readonly length: number;
  /** Zero is legal. Decision 6 leaves omitting such nodes to the tileset. */
  readonly pointCount: number;
}

/** A hierarchy page that has not been read yet. */
export interface PageDescriptor {
  readonly key: NodeKey;
  readonly offset: number;
  readonly length: number;
}

export interface HierarchyPage {
  readonly nodes: readonly NodeDescriptor[];
  readonly pages: readonly PageDescriptor[];
}

const KEY = /^(\d+)-(\d+)-(\d+)-(\d+)$/;

function parseKey(url: string, text: string): NodeKey {
  const match = KEY.exec(text);
  const [, depth, x, y, z] = match ?? [];
  if (depth === undefined || x === undefined || y === undefined || z === undefined) {
    // The page parsed but its keys are not octree addresses, so nothing built
    // from them would be meaningful. This is a defect in the file rather than
    // in the request that fetched it, and the error has to say which.
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(text)} is not addressed depth-x-y-z`,
    );
  }
  return { depth: Number(depth), x: Number(x), y: Number(y), z: Number(z) };
}

// copc.js reads an entry's length field as a signed Int32, so a corrupt page
// can hand out a negative one. Left alone it reaches formatRangeHeader, which
// refuses it as an InvalidByteRangeError — an error that blames how the request
// was built for a defect that is in the file.
function checkedLength(url: string, key: string, length: number): number {
  if (length < 0) {
    throw new MalformedHierarchyError(
      url,
      `its entry ${JSON.stringify(key)} declares a negative byte length of ${length}`,
    );
  }
  return length;
}

/**
 * Reads one hierarchy page and describes what it holds.
 *
 * The read goes through the reader rather than `Hierarchy.load` so that
 * merging stays the transport's job rather than this module's (Decision 4).
 * Actually coalescing two pages into one request needs `readMany` and a way to
 * hand the resulting buffers back in; both arrive with sub-page expansion.
 */
export async function readHierarchyPage(
  reader: RangeReader,
  page: ByteRange,
  signal?: AbortSignal,
): Promise<HierarchyPage> {
  // Required, not an optimisation: a zero-length range is refused by
  // formatRangeHeader, so asking for one would throw instead of reporting the
  // empty page the file actually describes.
  if (page.length === 0) {
    return { nodes: [], pages: [] };
  }

  const { bytes } = await reader.read(page, signal);

  // A truncated or padded page, and an out-of-range point count, are the
  // corruptions a real file is likeliest to have. copc.js reports both with a
  // bare Error that carries no code and names no file, so they get the same
  // typed treatment as an unreadable key (Decision 6).
  let subtree: Hierarchy.Subtree;
  try {
    subtree = Hierarchy.parse(new Uint8Array(bytes));
  } catch (cause) {
    throw new MalformedHierarchyError(
      reader.url,
      'its bytes could not be parsed as hierarchy entries',
      { cause },
    );
  }

  const nodes = Object.entries(subtree.nodes).flatMap<NodeDescriptor>(([key, node]) =>
    node === undefined
      ? []
      : [
          {
            key: parseKey(reader.url, key),
            offset: node.pointDataOffset,
            length: checkedLength(reader.url, key, node.pointDataLength),
            pointCount: node.pointCount,
          },
        ],
  );

  const pages = Object.entries(subtree.pages).flatMap<PageDescriptor>(([key, sub]) =>
    sub === undefined
      ? []
      : [
          {
            key: parseKey(reader.url, key),
            offset: sub.pageOffset,
            length: checkedLength(reader.url, key, sub.pageLength),
          },
        ],
  );

  return { nodes, pages };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/copc/hierarchy.ts tests/copc-hierarchy.test.ts
git commit -m "feat(copc): turn a hierarchy page into node descriptors"
```

---

### Task 5: Opening a file

**Files:**
- Create: `src/copc/open.ts`, `src/copc/index.ts`
- Test: `tests/copc-open.test.ts`

**Interfaces:**
- Consumes: `readFileHeader`, `readWkt`, `readHierarchyPage`.
- Produces:
  - `interface CopcFile { readonly header: Las.Header; readonly info: Info; readonly wkt: string | undefined; readonly totalBytes: number | null; readonly root: HierarchyPage }`
  - `openCopc(reader: RangeReader, signal?: AbortSignal): Promise<CopcFile>`
  - `src/copc/index.ts` re-exports every public type and function above.

> OVERVIEW §4 says `fromUrl` reads metadata and the root hierarchy, and nothing else. Three requests: the fixed first read, then the VLR region the header located, then the page the info VLR located — reads 2 and 3 both derived from what read 1 reported, not from each other.

- [ ] **Step 1: Write the failing test**

```ts
// tests/copc-open.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openCopc } from '../src/copc/index.js';
import type { ByteRange, RangeReader } from '../src/range/index.js';

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const SLICES: readonly { offset: number; bytes: Uint8Array }[] = [
  { offset: 0, bytes: load('autzen-head.bin') },
  { offset: 375, bytes: load('autzen-vlrs.bin') },
  { offset: 81_114_146, bytes: load('autzen-root-hierarchy.bin') },
];

/** Serves the pinned slices at their real file offsets, and refuses anything else. */
function autzenReader() {
  const reads: ByteRange[] = [];
  const reader: RangeReader = {
    url: 'https://host/autzen.copc.laz',
    read: (range) => {
      reads.push(range);
      const slice = SLICES.find(
        (candidate) =>
          range.offset >= candidate.offset &&
          range.offset + range.length <= candidate.offset + candidate.bytes.length,
      );
      if (slice === undefined) {
        throw new Error(`no fixture covers ${range.offset}+${range.length}`);
      }
      const start = range.offset - slice.offset;
      return Promise.resolve({
        bytes: slice.bytes.slice(start, start + range.length).buffer as ArrayBuffer,
        totalBytes: 81_123_042,
      });
    },
    readMany: () => Promise.reject(new Error('not used here')),
    stats: () => ({ requests: 0, retries: 0, bytesRequested: 0, bytesWasted: 0, requestsSaved: 0 }),
  };
  return { reader, reads };
}

describe('openCopc', () => {
  it('opens the file in three requests and no more', async () => {
    const { reader, reads } = autzenReader();

    await openCopc(reader);

    // §4: metadata and root hierarchy, nothing else. Reads 2 and 3 are both
    // derived from what read 1 reported.
    expect(reads).toEqual([
      { offset: 0, length: 589 },
      { offset: 375, length: 1361 },
      { offset: 81_114_146, length: 8896 },
    ]);
  });

  it('surfaces everything the rest of the library needs', async () => {
    const { reader } = autzenReader();

    const file = await openCopc(reader);

    expect(file.header.pointCount).toBe(10_653_336);
    expect(file.info.cube).toHaveLength(6);
    expect(file.wkt?.startsWith('COMPD_CS[')).toBe(true);
    expect(file.totalBytes).toBe(81_123_042);
    expect(file.root.nodes).toHaveLength(278);
    expect(file.root.pages).toEqual([]);
  });

  it('stops at the first failure instead of reading on', async () => {
    const { reader, reads } = autzenReader();
    // Spreading a reader that already satisfies the interface needs no cast.
    const broken: RangeReader = {
      ...reader,
      read: (range) => {
        if (range.offset === 0) {
          const bytes = new Uint8Array(load('autzen-head.bin'));
          bytes.set(new TextEncoder().encode('JUNK'), 0);
          reads.push(range);
          return Promise.resolve({ bytes: bytes.buffer as ArrayBuffer, totalBytes: null });
        }
        throw new Error('should not have read past the header');
      },
    };

    await expect(openCopc(broken)).rejects.toMatchObject({ code: 'not-copc' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/copc-open.test.ts`
Expected: FAIL — cannot resolve `../src/copc/index.js`.

- [ ] **Step 3: Write the composition**

```ts
// src/copc/open.ts
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
 * Decision 4 allows no request built on a guess.
 */
export async function openCopc(reader: RangeReader, signal?: AbortSignal): Promise<CopcFile> {
  const { header, info, totalBytes } = await readFileHeader(reader, signal);
  const wkt = await readWkt(reader, header, signal);
  const root = await readHierarchyPage(
    reader,
    { offset: info.rootHierarchyPage.pageOffset, length: info.rootHierarchyPage.pageLength },
    signal,
  );

  return { header, info, wkt, totalBytes, root };
}
```

```ts
// src/copc/index.ts
export type { CopcFileHeader } from './header.js';
export { readFileHeader } from './header.js';
export type { HierarchyPage, NodeDescriptor, NodeKey, PageDescriptor } from './hierarchy.js';
export { readHierarchyPage } from './hierarchy.js';
export type { CopcFile } from './open.js';
export { openCopc } from './open.js';
export { readWkt } from './wkt.js';
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/copc tests/copc-open.test.ts
git commit -m "feat(copc): open a file in the three reads §4 allows"
```

---

## Self-review before handing off

- [ ] No source file imports `copc`'s `Getter`, `Copc.create`, `Hierarchy.load`, or anything else taking a `string | Getter`.
- [ ] Every byte offset that appears more than once is a named constant with the reason cited.
- [ ] No test fetches anything; every byte comes from `fixtures/` or is built in the test.

## Done when

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` passes, including the six suites that existed before this plan.
- [ ] `src/copc/README.md` still describes what the module does; it already claims header, info VLR, and hierarchy pages, so check it reads true and leave it alone if so.
- [ ] No new entry in `package.json` `dependencies`.
