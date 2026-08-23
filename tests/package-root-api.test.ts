import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  BudgetCounterStats,
  COPCTilesetProviderOptions,
  FromWorker,
  ToWorker,
  WorkerPort,
} from 'copc-tileset-provider';
import { COPCTilesetProvider } from 'copc-tileset-provider';
import { createWorkerHandler } from 'copc-tileset-provider/worker';

/**
 * Every import above names the package rather than a path into `src/`, and
 * that is what this file is for: the two `exports` paths have to between them
 * reach everything a caller needs, or the package as declared cannot be used.
 * `spawnWorker` is typed `() => WorkerPort`, and the only thing that speaks
 * the protocol a `WorkerPort` speaks is `createWorkerHandler` — which lives at
 * `./worker`, not on the root, because the root re-exports
 * `COPCTilesetProvider` and so drags Cesium into whatever imports it.
 *
 * These names do **not** resolve to `dist/` here. `vitest.config.ts` aliases
 * them back to `src/`, because `npm test` stays offline and buildless
 * (CLAUDE.md). So this file pins the shape of the two barrels; what a consumer
 * actually receives is asserted by `smoke/`, against a real `npm pack`
 * tarball installed into a real project.
 */

const load = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

// Same proj4 definition every other suite registers for Autzen's own
// horizontal system (EPSG:2992, international feet).
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const HEAD = load('autzen-head.bin');
const VLRS = load('autzen-vlrs.bin');
const ROOT_HIERARCHY = load('autzen-root-hierarchy.bin');
const TOTAL_BYTES = 81_123_042;

/** Serves the three bootstrap ranges as 206 responses, and refuses anything else. */
function autzenFetch(): typeof globalThis.fetch {
  const slices = [
    { offset: 0, bytes: HEAD },
    { offset: 375, bytes: VLRS },
    { offset: 81_114_146, bytes: ROOT_HIERARCHY },
  ];
  return ((_input: unknown, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`expected a byte range header, got ${String(range)}`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = slices.find(
      (candidate) =>
        start >= candidate.offset && end < candidate.offset + candidate.bytes.length,
    );
    if (slice === undefined) {
      throw new Error(`no fixture slice covers bytes ${start}-${end}`);
    }
    return Promise.resolve(
      new Response(slice.bytes.slice(start - slice.offset, end - slice.offset + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${TOTAL_BYTES}` },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
}

/**
 * A `WorkerPort` built out of `createWorkerHandler` alone — the platform
 * wiring a consumer writes, here for the one platform that needs no bundler:
 * this same thread. A browser consumer replaces `deliver` with
 * `self.postMessage` and `post` with `worker.postMessage`; nothing else about
 * the shape changes, and none of it needs an export this file does not have.
 */
function spawnWorker(): WorkerPort {
  const messageHandlers: ((message: FromWorker) => void)[] = [];
  const handle = createWorkerHandler((message: FromWorker) => {
    for (const handler of messageHandlers) {
      handler(message);
    }
  });

  return {
    post(message: ToWorker) {
      void handle(message);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onError() {
      // Nothing here can throw out-of-band: `handle` reports every failure as
      // a `failed` message on the same channel a `done` would use.
    },
    terminate() {
      messageHandlers.length = 0;
    },
  };
}

describe('the package as declared', () => {
  it('lets a caller build a WorkerPort that speaks the protocol, from the package root alone', async () => {
    const port = spawnWorker();
    const ready = new Promise<FromWorker>((resolve) => {
      port.onMessage(resolve);
    });

    port.post({ kind: 'init', id: 1, definition: OREGON }, []);

    // `ready` rather than `failed` is the whole assertion: the handler
    // accepted this library's own `init` message and answered in this
    // library's own reply shape, so the port a consumer builds this way is
    // one `WorkerPool` can drive.
    expect(await ready).toEqual({ kind: 'ready', id: 1 });
  });

  it('accepts that port as fromUrl’s required spawnWorker option, and types the stats it returns', async () => {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    // Annotated, not inferred: the annotation is what proves `spawnWorker`
    // above satisfies the declared option type rather than merely being
    // shaped enough to pass at the call site.
    const options: COPCTilesetProviderOptions = { spawnWorker, fetch: autzenFetch() };

    const provider = await COPCTilesetProvider.fromUrl(
      'https://package-root-host.example/autzen.copc.laz',
      options,
    );

    // `BudgetStats`'s four fields are all `BudgetCounterStats`, so a caller
    // that wants a helper over one of them — rather than a single inlined
    // property read — needs that name too.
    const outstanding = (counter: BudgetCounterStats): number => counter.admitted - counter.inUse;
    expect(outstanding(provider.stats().budget.decode)).toBe(0);

    provider.destroy();
  });
});
