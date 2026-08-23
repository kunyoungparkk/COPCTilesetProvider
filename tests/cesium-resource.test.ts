import { Resource } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Admission, Budget } from '../src/budget/index.js';
import type { Lease } from '../src/budget/index.js';
import {
  LeaseAlreadyReleasedError,
  RangeRequestRejectedError,
  UnknownTileRequestError,
} from '../src/errors/index.js';
import type { RangeRead, RangeReader } from '../src/range/index.js';
import { ScheduledRangeResource, type InterceptContext } from '../src/cesium-runtime/resource.js';
import type { TileEntry } from '../src/tileset/index.js';

// This provider's own scheme, keyed to no real host. The shape is the one
// `buildTileset` emits: `<tokenBase>n/<depth>-<x>-<y>-<z>` for a points tile,
// `h/` for a hierarchy page.
const TOKEN_BASE = 'copc://a1b2c3/';
const ENTRY_URL = `${TOKEN_BASE}n/0-0-0-0`;
// The remote COPC file this provider reads from — distinct from the Blob URL
// the tileset JSON itself is served at, and from the tokenBase scheme.
const FILE_URL = 'https://host/autzen.copc.laz';
const TILESET_URL = 'blob:http://localhost/00000000-0000-0000-0000-000000000000';

function makeEntry(): TileEntry {
  return { kind: 'points', key: { depth: 0, x: 0, y: 0, z: 0 }, offset: 1000, length: 47, pointCount: 12 };
}

/**
 * Mirrors Decision 5's single-use rule (`src/budget/lease.ts`'s `createLease`)
 * without needing a whole `Budget`: `release()` a second time throws the same
 * typed error the real one does.
 */
function fakeLease(): { lease: Lease; releaseCount: () => number } {
  let released = false;
  let calls = 0;
  return {
    lease: {
      release(): void {
        calls += 1;
        if (released) {
          throw new LeaseAlreadyReleasedError();
        }
        released = true;
      },
    },
    releaseCount: () => calls,
  };
}

/** A `Budget` stub whose `acquireRangeRequest` always hands back one fixed verdict. */
function fakeBudget(admission: Admission): Budget {
  return {
    acquireRangeRequest: () => admission,
    acquireDecodeJob: () => {
      throw new Error('not exercised by this test');
    },
    stats: () => {
      throw new Error('not exercised by this test');
    },
    destroy: () => {
      /* not exercised by this test */
    },
  };
}

/**
 * Same as `fakeBudget`, but `acquireRangeRequest` is a spy — so a test can
 * assert what it was actually called with, not just what it returned.
 * Without this, a wrong origin (mis-keying the per-host slot registry) or a
 * wrong byte count (silently disabling `rangeBodyBytes`) is invisible: every
 * other test in this file only checks the verdict that comes back.
 */
function spiedBudget(admission: Admission): { budget: Budget; acquireRangeRequest: ReturnType<typeof vi.fn> } {
  const acquireRangeRequest = vi.fn(() => admission);
  return { budget: { ...fakeBudget(admission), acquireRangeRequest }, acquireRangeRequest };
}

function fakeReader(overrides: Partial<RangeReader> = {}): RangeReader {
  return {
    url: FILE_URL,
    read: vi.fn(() => Promise.reject(new Error('unexpected read in this test'))),
    readMany: vi.fn(),
    stats: vi.fn(() => ({
      requests: 0,
      retries: 0,
      bytesRequested: 0,
      bytesWasted: 0,
      requestsSaved: 0,
    })),
    ...overrides,
  };
}

function makeContext(overrides: Partial<InterceptContext> = {}): InterceptContext {
  return {
    reader: fakeReader(),
    budget: fakeBudget({ verdict: 'deferred' }),
    entries: new Map([[ENTRY_URL, makeEntry()]]),
    tokenBase: TOKEN_BASE,
    url: FILE_URL,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clone and getDerivedResource', () => {
  it('both return a ScheduledRangeResource, and the clone still resolves a registry hit', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const { lease } = fakeLease();
    const context = makeContext({
      budget: fakeBudget({ verdict: 'admitted', lease }),
      reader: fakeReader({ read: vi.fn(() => Promise.resolve({ bytes, totalBytes: null })) }),
    });
    const root = new ScheduledRangeResource({ url: TILESET_URL }, context);

    const cloned = root.clone();
    expect(cloned).toBeInstanceOf(ScheduledRangeResource);

    // A clone that is the right class but lost its context would fail this
    // same way one call later — resolving a registry hit is what proves the
    // context survived, not just the constructor name.
    const derived = cloned.getDerivedResource({ url: ENTRY_URL });
    expect(derived).toBeInstanceOf(ScheduledRangeResource);

    await expect((derived as ScheduledRangeResource).fetchArrayBuffer()).resolves.toBe(bytes);
  });

  // `getDerivedResource` (`Core/Resource.js:664-665`) always calls `this.clone()`
  // with no argument, so the `result` branch below is never exercised through
  // that path — but `clone(result)` is still part of the public override, and
  // Cesium's own `IonResource` copies its fields onto a passed-in `result`
  // rather than trusting the target already carries them. This test calls
  // that branch directly: a `result` built with a stale context must end up
  // carrying the *source's* context, not the one it was constructed with.
  it('clone(result) makes an existing resource adopt the source\'s context', async () => {
    const bytes = new Uint8Array([4, 5, 6]).buffer;
    const context = makeContext({
      budget: fakeBudget({ verdict: 'admitted', lease: fakeLease().lease }),
      reader: fakeReader({ read: vi.fn(() => Promise.resolve({ bytes, totalBytes: null })) }),
    });
    const root = new ScheduledRangeResource({ url: TILESET_URL }, context);
    const staleContext = makeContext({ entries: new Map() });
    const target = new ScheduledRangeResource({ url: TILESET_URL }, staleContext);

    const result = root.clone(target);

    expect(result).toBe(target);
    const derived = (result as ScheduledRangeResource).getDerivedResource({ url: ENTRY_URL });
    await expect((derived as ScheduledRangeResource).fetchArrayBuffer()).resolves.toBe(bytes);
  });
});

describe('a registry hit', () => {
  it('admitted: resolves to exactly the descriptor bytes read through the reader', async () => {
    const bytes = new Uint8Array([9, 8, 7]).buffer;
    const { lease, releaseCount } = fakeLease();
    const read = vi.fn(() => Promise.resolve<RangeRead>({ bytes, totalBytes: null }));
    const { budget, acquireRangeRequest } = spiedBudget({ verdict: 'admitted', lease });
    const context = makeContext({ budget, reader: fakeReader({ read }) });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    await expect(resource.fetchArrayBuffer()).resolves.toBe(bytes);

    // The signal comes with the range, always: `Resource`'s constructor
    // assigns `this.request = options.request ?? new Request()`
    // (Core/Resource.js:121), so there is always one to watch — it simply
    // never fires unless Cesium cancels.
    expect(read).toHaveBeenCalledWith({ offset: 1000, length: 47 }, expect.any(AbortSignal));
    expect((read.mock.calls[0] as unknown[])[1]).toMatchObject({ aborted: false });
    expect(releaseCount()).toBe(1);
    // FILE_URL is 'https://host/autzen.copc.laz' and the entry is 47 bytes —
    // a wrong origin here would mis-key the per-host slot registry, and a
    // wrong byte count would silently disable the byte budget.
    expect(acquireRangeRequest).toHaveBeenCalledWith('https://host', 47);
  });

  it('deferred: returns undefined, not null and not a rejected promise', () => {
    const context = makeContext({ budget: fakeBudget({ verdict: 'deferred' }) });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    const result = resource.fetchArrayBuffer();

    expect(result).toBeUndefined();
  });

  it('rejected: returns a rejected promise carrying a typed error', async () => {
    const context = makeContext({
      budget: fakeBudget({ verdict: 'rejected', reason: 'over-capacity' }),
    });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    await expect(resource.fetchArrayBuffer()).rejects.toBeInstanceOf(RangeRequestRejectedError);
  });
});

describe('the admission origin', () => {
  // Measured: `new URL('/data/a.copc.laz')` throws `TypeError: Invalid URL`.
  // `Cesium3DTile.prototype.requestContent` calls `fetchArrayBuffer()` with no
  // `try` around it, so if this were computed there instead, the throw would
  // surface mid-frame, inside Cesium's own traversal, rather than where
  // `fromUrl` can reject it. Computing it in the constructor moves the throw
  // to construction, which for every resource here happens inside `fromUrl`.
  it('is computed at construction, so a non-absolute context.url fails there', () => {
    const context = makeContext({ url: '/data/a.copc.laz' });

    expect(() => new ScheduledRangeResource({ url: ENTRY_URL }, context)).toThrow(TypeError);
  });
});

describe('a miss', () => {
  it('under this library\u2019s scheme but another provider\u2019s tokenBase: typed error, no network', async () => {
    // Two providers on one globe each mint their own `tokenBase`, so this URI
    // is real — it is just the other provider's. Measured against a gate that
    // tested `startsWith(tokenBase)` instead of the scheme: this fell through
    // to `super.fetchArrayBuffer()` and made a genuine network attempt,
    // failing with Cesium's own `RequestErrorEvent` rather than a typed error.
    const superFetch = vi
      .spyOn(Resource.prototype, 'fetchArrayBuffer')
      .mockReturnValue(Promise.resolve(new ArrayBuffer(0)));
    const context = makeContext();
    const resource = new ScheduledRangeResource({ url: 'copc://d4e5f6/n/0-0-0-0' }, context);

    await expect(resource.fetchArrayBuffer()).rejects.toBeInstanceOf(UnknownTileRequestError);

    expect(superFetch).not.toHaveBeenCalled();
  });

  it('not under tokenBase: delegates to super.fetchArrayBuffer()', async () => {
    const bytes = new ArrayBuffer(4);
    const superFetch = vi
      .spyOn(Resource.prototype, 'fetchArrayBuffer')
      .mockReturnValue(Promise.resolve(bytes));
    const context = makeContext();
    const resource = new ScheduledRangeResource({ url: TILESET_URL }, context);

    await expect(resource.fetchArrayBuffer()).resolves.toBe(bytes);

    expect(superFetch).toHaveBeenCalledTimes(1);
    expect(superFetch.mock.instances[0]).toBe(resource);
  });

  it('under tokenBase but unknown: fails with a typed error rather than reaching super', async () => {
    // A mock implementation, not a bare spy: without one, a regression that
    // reaches `super` would call through to the real `fetchArrayBuffer`, and
    // this test would only pass because Node has no `XMLHttpRequest` to
    // actually reach the network with. The mock makes "never touches the
    // network" true regardless of environment.
    const superFetch = vi
      .spyOn(Resource.prototype, 'fetchArrayBuffer')
      .mockReturnValue(Promise.resolve(new ArrayBuffer(0)));
    const context = makeContext();
    // Same tokenBase, but no entry was ever registered for this key.
    const resource = new ScheduledRangeResource({ url: `${TOKEN_BASE}n/9-9-9-9` }, context);

    await expect(resource.fetchArrayBuffer()).rejects.toBeInstanceOf(UnknownTileRequestError);

    expect(superFetch).not.toHaveBeenCalled();
  });
});

describe('the Range lease is released on every path', () => {
  it('resolve: released exactly once', async () => {
    const bytes = new ArrayBuffer(4);
    const { lease, releaseCount } = fakeLease();
    const context = makeContext({
      budget: fakeBudget({ verdict: 'admitted', lease }),
      reader: fakeReader({ read: vi.fn(() => Promise.resolve({ bytes, totalBytes: null })) }),
    });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    await expect(resource.fetchArrayBuffer()).resolves.toBe(bytes);

    expect(releaseCount()).toBe(1);
  });

  it('reject: the reader failing still releases exactly once, and the error propagates', async () => {
    const { lease, releaseCount } = fakeLease();
    const readError = new Error('range read failed');
    const context = makeContext({
      budget: fakeBudget({ verdict: 'admitted', lease }),
      reader: fakeReader({ read: vi.fn(() => Promise.reject(readError)) }),
    });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    await expect(resource.fetchArrayBuffer()).rejects.toBe(readError);

    expect(releaseCount()).toBe(1);
  });

  // `RangeReader` is a public interface; nothing in its type requires `read`
  // to be `async` (the shipped one is, but a caller-supplied implementation
  // could throw synchronously instead of returning a rejected promise). A
  // `.then(onFulfilled, onRejected)` pair cannot see that throw at all.
  it('the reader throwing synchronously still releases exactly once', async () => {
    const { lease, releaseCount } = fakeLease();
    const readError = new Error('range read failed synchronously');
    const context = makeContext({
      budget: fakeBudget({ verdict: 'admitted', lease }),
      reader: fakeReader({
        read: vi.fn(() => {
          throw readError;
        }),
      }),
    });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    await expect(resource.fetchArrayBuffer()).rejects.toBe(readError);

    expect(releaseCount()).toBe(1);
  });

  it('a super delegation that throws: propagates without touching a lease that was never acquired', async () => {
    const superError = new Error('no XMLHttpRequest in this environment');
    vi.spyOn(Resource.prototype, 'fetchArrayBuffer').mockImplementation(() => {
      throw superError;
    });
    const acquireRangeRequest = vi.fn(() => ({ verdict: 'deferred' }) as Admission);
    const context = makeContext({
      budget: { ...fakeBudget({ verdict: 'deferred' }), acquireRangeRequest },
    });
    // Not in the registry and not under tokenBase, so this takes the miss →
    // super branch, which never touches the budget at all.
    const resource = new ScheduledRangeResource({ url: TILESET_URL }, context);

    expect(() => resource.fetchArrayBuffer()).toThrow(superError);
    expect(acquireRangeRequest).not.toHaveBeenCalled();
  });
});

describe('cancellation', () => {
  it('aborts the read when Cesium cancels the tile, and still returns the lease', async () => {
    const { lease, releaseCount } = fakeLease();
    let seen: AbortSignal | undefined;
    const read = vi.fn(
      (_range: unknown, signal?: AbortSignal) =>
        new Promise<RangeRead>((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { budget } = spiedBudget({ verdict: 'admitted', lease });
    const context = makeContext({ budget, reader: fakeReader({ read }) });
    const resource = new ScheduledRangeResource({ url: ENTRY_URL }, context);

    const promise = resource.fetchArrayBuffer();
    expect(seen?.aborted).toBe(false);

    // What `Cesium3DTile.cancelRequests` does, and all it does.
    (resource as unknown as { request: { cancel: () => void } }).request.cancel();

    await expect(promise).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
    // Decision 5: the lease returns on every path, cancellation included.
    expect(releaseCount()).toBe(1);
  });

  it('marks the request cancelled, which is how Cesium tells retry from failure', async () => {
    // `processArrayBuffer` reads `request.cancelled` to decide whether a
    // rejected fetch restores the tile's previous state or fails it
    // terminally (`tests/cesium-contract.test.ts` pins that branch). Wrapping
    // `cancel` for the signal must not cost the flag.
    const { lease } = fakeLease();
    const read = vi.fn(
      (_range: unknown, signal?: AbortSignal) =>
        new Promise<RangeRead>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { budget } = spiedBudget({ verdict: 'admitted', lease });
    const resource = new ScheduledRangeResource(
      { url: ENTRY_URL },
      makeContext({ budget, reader: fakeReader({ read }) }),
    );

    const promise = resource.fetchArrayBuffer();
    const request = (resource as unknown as { request: { cancel: () => void; cancelled: boolean } })
      .request;
    request.cancel();
    await expect(promise).rejects.toThrow();

    expect(request.cancelled).toBe(true);
  });
});
