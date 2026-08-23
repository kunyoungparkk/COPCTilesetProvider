import { describe, expect, it, vi } from 'vitest';
import { browserPort, spawnBundledWorker } from '../src/cesium-runtime/spawn.js';
import { COPCTilesetProvider } from '../src/cesium-runtime/provider.js';
import { WorkerBundleMissingError } from '../src/errors/index.js';

describe('spawnBundledWorker', () => {
  it('refuses with a typed error when this build inlined no Worker', () => {
    // Running from source there is no built Worker to inline, so this is the
    // path every unit test takes. A consumer of the tarball never sees it —
    // `smoke/` is what covers the other branch, against a real tarball.
    expect(() => spawnBundledWorker()).toThrow(WorkerBundleMissingError);
  });

  it('tells the caller both ways out', () => {
    let thrown: unknown;
    try {
      spawnBundledWorker();
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    // Decision 6: an error is API. Naming the option and the script is what
    // makes this actionable rather than merely accurate.
    expect(message).toContain('spawnWorker');
    expect(message).toContain('npm run build');
    expect(message).toContain('browserPort');
  });
});

describe('browserPort', () => {
  it('adds message handlers rather than replacing them', () => {
    const listeners: ((event: { data: unknown }) => void)[] = [];
    const worker = {
      addEventListener: vi.fn((_type: string, handler: (event: { data: unknown }) => void) => {
        listeners.push(handler);
      }),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const port = browserPort(worker as unknown as Worker);
    const first = vi.fn();
    const second = vi.fn();
    port.onMessage(first);
    port.onMessage(second);
    // `WorkerPort.onMessage` promises registration adds to earlier ones. A
    // `worker.onmessage = handler` implementation would silently drop `first`,
    // and `tests/worker-entry.test.ts` relies on that contract to await more
    // than one reply.
    for (const listener of listeners) listener({ data: { kind: 'ready', id: 1 } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('hands postMessage the buffers it was told to transfer', () => {
    const worker = { addEventListener: vi.fn(), postMessage: vi.fn(), terminate: vi.fn() };
    const port = browserPort(worker as unknown as Worker);
    const buffer = new ArrayBuffer(8);
    port.post({ kind: 'init', id: 1, definition: '+proj=longlat' }, [buffer]);
    // Decision 3: the compressed chunk moves rather than copies. Dropping the
    // second argument would still work and would silently clone every chunk.
    expect(worker.postMessage).toHaveBeenCalledWith(expect.anything(), [buffer]);
  });
});

describe('fromUrl without an options argument', () => {
  it('declares the options parameter as defaulted, not required', () => {
    // `fromUrl(url)` is the call OVERVIEW §1 promises and the one the publish
    // smoke makes. Every field of the options type was optional, but the
    // parameter itself was not — so a one-argument call threw `Cannot read
    // properties of undefined (reading 'fetch')` before reaching any of the
    // library's own checks. Nothing offline caught it, because every other
    // test passes an options object; the packed tarball did.
    //
    // `Function.length` counts parameters before the first defaulted one, so
    // this is 1 with the default and 2 without — confirmed by mutation.
    // Calling `fromUrl(url)` for real would be the more obvious test and does
    // not work: the invalid-URL guard runs before the options are ever read,
    // so a bad URL throws the same error either way, and a good one would put
    // the offline suite on the network.
    expect(COPCTilesetProvider.fromUrl.length).toBe(1);
  });
});
