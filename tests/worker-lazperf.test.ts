import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import wasmBinary from 'virtual:laz-perf-wasm';
import { getLazPerf } from '../src/worker/lazperf.js';

// The bytes the plugin hands the bundle have to be the bytes on disk. Measured
// by mutation: truncating the buffer by a single byte inside
// `wasmModuleSource` fails this and takes the two instantiation tests with it.
// What it cannot catch is the plugin reading laz-perf's `node` or `worker`
// directory instead of `web` — all three ship the same wasm, which the next
// test pins deliberately.
const ON_DISK = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../node_modules/laz-perf/lib/web/laz-perf.wasm', import.meta.url)),
  ),
);

const wasmFor = (build: string) =>
  new Uint8Array(
    readFileSync(
      fileURLToPath(new URL(`../node_modules/laz-perf/lib/${build}/laz-perf.wasm`, import.meta.url)),
    ),
  );

describe('the inlined laz-perf wasm', () => {
  it('is byte-for-byte the web build on disk', () => {
    expect(wasmBinary).toEqual(ON_DISK);
  });

  it('is the same decoder laz-perf ships to every environment', () => {
    // This is what makes it safe for the suite to run laz-perf's Node glue
    // while the published bundle runs its web glue: the glue differs, the
    // compiled decoder does not. If a laz-perf upgrade ever breaks this, the
    // tests stop standing in for the thing that ships and we want to be told.
    expect(wasmFor('node')).toEqual(wasmFor('web'));
    expect(wasmFor('worker')).toEqual(wasmFor('web'));
  });

  it('starts a decoder without any URL to fetch from', async () => {
    const lazPerf = await getLazPerf();
    // `_malloc` and `ChunkDecoder` are what `decompressChunk` actually uses;
    // a module that failed to instantiate has neither.
    expect(typeof lazPerf._malloc).toBe('function');
    expect(typeof lazPerf.ChunkDecoder).toBe('function');
  });

  it('builds the module once, however many callers ask', async () => {
    expect(await getLazPerf()).toBe(await getLazPerf());
  });
});
