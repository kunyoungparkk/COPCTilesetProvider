/**
 * The suite's one way in to `fixtures/`, and the fake network it is served
 * over.
 *
 * Deliberately not used by `tests/copc-fixtures.test.ts`: that file checks the
 * pinned slices against `fixtures/provenance.json`, so it reads them itself
 * rather than through a helper it would then be trusting to have read them
 * correctly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The URL the pinned file is given wherever a test needs one. */
export const FILE_URL = 'https://host/autzen.copc.laz';

/** `autzen-classified.copc.laz`'s real size, which every 206 below reports. */
export const TOTAL_BYTES = 81_123_042;

/** One pinned slice, by its name under `fixtures/`. */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))),
  );
}

/** A pinned slice and the file offset it was cut from. */
export interface FixtureSlice {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/**
 * Serves a fixed set of byte ranges as 206 responses, and refuses anything
 * else — so a test that asks for a range it did not pin fails naming the
 * range, rather than by whatever a short or empty body happens to parse as.
 *
 * `ranges` records every `Range` header seen, in order, including one that was
 * missing (as `'(none)'`) and one that is then refused. Recording before the
 * shape check is what lets a test assert on a request it also expects to fail.
 */
export function fixtureFetch(slices: readonly FixtureSlice[]): {
  fetch: typeof globalThis.fetch;
  ranges: string[];
} {
  const ranges: string[] = [];
  const fetch = ((_input: unknown, init?: RequestInit) => {
    const requested = new Headers(init?.headers).get('range');
    ranges.push(requested ?? '(none)');

    const match = requested === null ? null : /^bytes=(\d+)-(\d+)$/.exec(requested);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`expected a byte range header, got ${String(requested)}`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);

    const slice = slices.find(
      (candidate) => start >= candidate.offset && end < candidate.offset + candidate.bytes.length,
    );
    if (slice === undefined) {
      throw new Error(`no fixture slice covers bytes ${start}-${end}`);
    }

    const from = start - slice.offset;
    return Promise.resolve(
      new Response(slice.bytes.slice(from, from + (end - start + 1)), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${TOTAL_BYTES}` },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { fetch, ranges };
}
