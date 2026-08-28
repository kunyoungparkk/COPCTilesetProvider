import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Resource } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as budgetModule from '../src/budget/index.js';
import { COPCTilesetProvider, DELEGATED_PRIMITIVE_METHODS } from '../src/cesium-runtime/provider.js';
import * as poolModule from '../src/worker/pool.js';
import type { WorkerPort } from '../src/worker/pool.js';
import { fixtureBytes as load, fixtureFetch } from './fixtures.js';
import { encodeHierarchyPage } from './hierarchy-page.js';

// Same proj4 definition tests/cesium-provider.test.ts and tests/cesium-codec.test.ts
// register for Autzen's own horizontal system (EPSG:2992, international feet).
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

const HEAD = load('autzen-head.bin');
const VLRS = load('autzen-vlrs.bin');
const ROOT_HIERARCHY = load('autzen-root-hierarchy.bin');

const autzenFetch = () =>
  fixtureFetch([
    { offset: 0, bytes: HEAD },
    { offset: 375, bytes: VLRS },
    { offset: 81_114_146, bytes: ROOT_HIERARCHY },
  ]).fetch;

/** None of these tests ever admits a decode job, so a call here is a defect. */
const spawnWorker = (): WorkerPort => {
  throw new Error('spawnWorker should not be called by any test in this file');
};

/**
 * A distinct file URL per describe block, so the per-origin request budget
 * (module state keyed by origin, whichever test file claims it first fixes
 * its capacity) never has to be shared with another test file's own
 * assumptions when the suite runs `--no-isolate`.
 */
async function buildProvider(host: string): Promise<COPCTilesetProvider> {
  COPCTilesetProvider.registerCrs(2992, OREGON);
  return COPCTilesetProvider.fromUrl(`https://${host}/autzen.copc.laz`, {
    spawnWorker,
    fetch: autzenFetch(),
  });
}

/**
 * The same capture the two single-resource `destroy` tests below do inline,
 * for the two tests that need both at once. Spying on the factories is the
 * only way to reach either: the provider holds both in private fields.
 */
async function buildProviderCapturingOwnedResources(host: string): Promise<{
  provider: COPCTilesetProvider;
  pool: { destroy: () => void };
  budget: { destroy: () => void };
}> {
  const poolSpy = vi.spyOn(poolModule, 'createWorkerPool');
  const budgetSpy = vi.spyOn(budgetModule, 'createBudget');
  const provider = await buildProvider(host);
  // Read out before restoring: `mockRestore()` also clears `mock.results`.
  const pool = poolSpy.mock.results[0]?.value as { destroy: () => void };
  const budget = budgetSpy.mock.results[0]?.value as { destroy: () => void };
  poolSpy.mockRestore();
  budgetSpy.mockRestore();
  return { provider, pool, budget };
}

// Every provider built in this file loads the pinned Autzen fixture, whose
// WKT declares vertical CRS EPSG:6360, without a `geoidHeight` — correct
// behaviour (tested in tests/cesium-provider.test.ts), but noise here, where
// nothing in this file is about the warning.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('COPCTilesetProvider as a Cesium primitive', () => {
  it('implements exactly the methods PrimitiveCollection calls on a member it holds', async () => {
    // The same offline-source-scan shape tests/cesium-contract.test.ts uses:
    // read the installed engine's own source rather than trust a description
    // of it, so a Cesium upgrade that changes this set is what fails here.
    const resolveFrom = createRequire(import.meta.url);
    const source = readFileSync(
      resolveFrom.resolve('@cesium/engine/Source/Scene/PrimitiveCollection.js'),
      'utf8',
    );

    const scanned = new Set<string>();

    // Direct calls on the array element: `primitives[i].update(...)` inside
    // `PrimitiveCollection.prototype.update`, and `primitive.<name>(...)`
    // everywhere else a member's own method is invoked (the loop variable is
    // named `primitive` in every other case). The array-index half is
    // name-agnostic (`\w+` rather than the literal `primitives`), so a
    // future version indexing under a different name still matches.
    const directPattern = /\bprimitive\.(\w+)\(|\b\w+\[\s*i\s*\]\.(\w+)\(/g;
    for (const match of source.matchAll(directPattern)) {
      const name = match[1] ?? match[2];
      if (name !== undefined) {
        scanned.add(name);
      }
    }

    // Calls through a local alias bound to the array element earlier in the
    // same function (`const member = primitives[i]; member.foo();`) — a
    // shape neither pattern above would catch on its own, since the call
    // site names neither `primitive` nor an `[i]` index expression.
    const aliasPattern = /\b(?:const|let)\s+(\w+)\s*=\s*(?:primitive|\w+\[\s*i\s*\])\s*;/g;
    for (const aliasMatch of source.matchAll(aliasPattern)) {
      const alias = aliasMatch[1];
      if (alias === undefined) {
        continue;
      }
      const callPattern = new RegExp(`\\b${alias}\\.(\\w+)\\(`, 'g');
      for (const callMatch of source.matchAll(callPattern)) {
        const name = callMatch[1];
        if (name !== undefined) {
          scanned.add(name);
        }
      }
    }

    // Guard the guard: an empty set (a regex that stopped matching, say)
    // would make the equality below pass vacuously against an empty
    // `DELEGATED_PRIMITIVE_METHODS`, proving nothing.
    expect(scanned.size).toBeGreaterThan(0);

    // This binds the *declared constant* to what Cesium actually calls, not
    // the class to the constant — `COPCTilesetProvider` gaining an unrelated
    // method reddens nothing here. The per-name check below is what ties the
    // constant to the class; together the two mean "the class implements
    // exactly what Cesium calls, and nothing here vouches for anything else
    // the class happens to have".
    expect(new Set(DELEGATED_PRIMITIVE_METHODS)).toEqual(scanned);

    const provider = await buildProvider('primitive-scan-host.example');
    for (const name of scanned) {
      expect(
        typeof (provider as unknown as Record<string, unknown>)[name],
        `provider.${name} should be a function`,
      ).toBe('function');
    }
  });

  it('forwards update(frameState) to the tileset exactly once, with the same argument', async () => {
    const provider = await buildProvider('update-host.example');
    const spy = vi.spyOn(provider.tileset as unknown as { update: () => void }, 'update').mockImplementation(() => {});
    const frameState = { marker: 'frame' };

    provider.update(frameState);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(frameState);
  });

  it('forwards updateForPass(frameState, passState) to the tileset exactly once, with both arguments', async () => {
    const provider = await buildProvider('update-for-pass-host.example');
    const spy = vi.spyOn(provider.tileset as unknown as { updateForPass: () => void }, 'updateForPass').mockImplementation(() => {});
    const frameState = { marker: 'frame' };
    const passState = { marker: 'pass' };

    provider.updateForPass(frameState, passState);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(frameState, passState);
  });

  it('forwards prePassesUpdate(frameState) to the tileset exactly once, with the same argument', async () => {
    const provider = await buildProvider('pre-passes-host.example');
    const spy = vi.spyOn(provider.tileset as unknown as { prePassesUpdate: () => void }, 'prePassesUpdate').mockImplementation(() => {});
    const frameState = { marker: 'frame' };

    provider.prePassesUpdate(frameState);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(frameState);
  });

  it('forwards postPassesUpdate(frameState) to the tileset exactly once, with the same argument', async () => {
    const provider = await buildProvider('post-passes-host.example');
    const spy = vi.spyOn(provider.tileset as unknown as { postPassesUpdate: () => void }, 'postPassesUpdate').mockImplementation(() => {});
    const frameState = { marker: 'frame' };

    provider.postPassesUpdate(frameState);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(frameState);
  });
});

describe('COPCTilesetProvider#destroy', () => {
  it('destroys the tileset', async () => {
    const provider = await buildProvider('destroy-tileset-host.example');
    const spy = vi.spyOn(provider.tileset, 'destroy');

    provider.destroy();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('destroys the Worker pool', async () => {
    const poolSpy = vi.spyOn(poolModule, 'createWorkerPool');
    const provider = await buildProvider('destroy-pool-host.example');
    // Captured before restoring: `mockRestore()` also clears `mock.results`,
    // so the pool this call actually returned has to be read out first.
    const pool = poolSpy.mock.results[0]?.value as { destroy: () => void };
    poolSpy.mockRestore();
    const destroySpy = vi.spyOn(pool, 'destroy');

    provider.destroy();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('destroys the budget', async () => {
    const budgetSpy = vi.spyOn(budgetModule, 'createBudget');
    const provider = await buildProvider('destroy-budget-host.example');
    // Captured before restoring: `mockRestore()` also clears `mock.results`,
    // so the budget this call actually returned has to be read out first.
    const budget = budgetSpy.mock.results[0]?.value as { destroy: () => void };
    budgetSpy.mockRestore();
    const destroySpy = vi.spyOn(budget, 'destroy');

    provider.destroy();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('releases the pool and the budget even when the caller destroyed the tileset first', async () => {
    // `tileset` is public, and `scene.primitives.add(provider.tileset)` is
    // the shape every Cesium tutorial teaches, so a caller destroying it
    // itself is ordinary rather than exotic. Measured: Cesium's
    // `destroyObject` then makes `tileset.destroy()` throw `DeveloperError`,
    // which before the guard in `destroy()` ended the whole method there —
    // the pool, its Worker threads and their laz-perf WASM instances stayed
    // alive for the life of the page while `isDestroyed()` reported `true`.
    const { provider, pool, budget } = await buildProviderCapturingOwnedResources(
      'destroy-after-tileset-host.example',
    );
    const poolDestroy = vi.spyOn(pool, 'destroy');
    const budgetDestroy = vi.spyOn(budget, 'destroy');

    provider.tileset.destroy();
    expect(() => {
      provider.destroy();
    }).not.toThrow();

    expect(poolDestroy).toHaveBeenCalledTimes(1);
    expect(budgetDestroy).toHaveBeenCalledTimes(1);
    expect(provider.isDestroyed()).toBe(true);
  });

  it('releases the budget even when an earlier release throws, and rethrows that error', async () => {
    const { provider, pool, budget } = await buildProviderCapturingOwnedResources(
      'destroy-throwing-release-host.example',
    );
    const failure = new Error('pool teardown failed');
    vi.spyOn(pool, 'destroy').mockImplementation(() => {
      throw failure;
    });
    const budgetDestroy = vi.spyOn(budget, 'destroy');

    // The pool is destroyed before the budget, so a plain sequence would
    // strand the budget here. The error still reaches the caller — releasing
    // the rest is not the same as swallowing the failure.
    expect(() => {
      provider.destroy();
    }).toThrow(failure);

    expect(budgetDestroy).toHaveBeenCalledTimes(1);
  });

  it('revokes the Blob URL fromUrl created for the synthetic tileset document', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const provider = await buildProvider('destroy-bloburl-host.example');

    // `fromUrl`'s own `finally` already revokes it once, before this
    // instance exists — that call's own argument is the value destroy()
    // must revoke again.
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    const blobUrl = revokeSpy.mock.calls[0]?.[0];

    provider.destroy();

    // This second call is provably a no-op: `fromUrl`'s own `finally` above
    // already revoked `blobUrl` before this instance existed, and revoking
    // an already-revoked URL does nothing observable (`destroy()`'s own code
    // comment says the same). What this proves is narrower than "revoking
    // it here does something" — only that `destroy()` reaches for the
    // *correct* value when it makes that call, rather than some other
    // string or none at all.
    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(revokeSpy).toHaveBeenNthCalledWith(2, blobUrl);
  });

  it('is safe to call twice, and isDestroyed() reports correctly across both calls', async () => {
    const provider = await buildProvider('double-destroy-host.example');

    expect(provider.isDestroyed()).toBe(false);
    expect(() => {
      provider.destroy();
    }).not.toThrow();
    expect(provider.isDestroyed()).toBe(true);
    expect(() => {
      provider.destroy();
    }).not.toThrow();
    expect(provider.isDestroyed()).toBe(true);
  });

  it('leaves a delegated update hook a no-op after destroy(), rather than throwing Cesium’s own DeveloperError', async () => {
    const provider = await buildProvider('post-destroy-host.example');

    provider.destroy();

    // Measured: `tileset.update` after `tileset.destroy()` throws Cesium's
    // own `DeveloperError` directly (`Core/destroyObject.js`). The guard in
    // `update` is what keeps that from surfacing here.
    expect(() => {
      provider.update({});
    }).not.toThrow();
    expect(() => {
      provider.updateForPass({}, {});
    }).not.toThrow();
    expect(() => {
      provider.prePassesUpdate({});
    }).not.toThrow();
    expect(() => {
      provider.postPassesUpdate({});
    }).not.toThrow();
  });
});

describe('COPCTilesetProvider#stats', () => {
  it('surfaces range stats (including the merge waste ratio’s two components), budget stats, and synthesizedAncestors', async () => {
    const provider = await buildProvider('stats-shape-host.example');

    const stats = provider.stats();

    // §7's merge-waste ratio is bytesWasted / bytesRequested — both have to
    // be reachable for that ratio to ever be computed, not just one of them.
    // This only proves the *shape* — that `stats()` returns these fields as
    // numbers at all, which a hard-coded `0` would also satisfy. Liveness —
    // that they reflect real Range traffic — is
    // `tests/cesium-provider.test.ts`'s "fetches the root tile content..."
    // test, which reads `stats().range.requests` back against real fetches.
    expect(typeof stats.range.bytesRequested).toBe('number');
    expect(typeof stats.range.bytesWasted).toBe('number');
    expect(typeof stats.range.requests).toBe('number');

    expect(typeof stats.budget.rangeBody.admitted).toBe('number');
    expect(typeof stats.budget.hostRequests.admitted).toBe('number');

    // The pinned Autzen fixture's own root hierarchy page has no gap: every
    // node down to its own leaves is named directly, so nothing is
    // synthesized to bridge one. On its own this would also pass against a
    // `stats()` hard-wired to return `0` — the "synthesizedAncestors" describe
    // block below is what rules that out, by growing this same field.
    expect(stats.synthesizedAncestors).toBe(0);
  });
});

describe('the multi-page fixture: a hierarchy sub-page expanded through the installed codec', () => {
  // The pinned Autzen fixture's own root hierarchy page has no sub-pages (its
  // whole octree fits in one page), so neither synthesizedAncestors
  // accumulation nor a live sub-page registry entry can be observed against
  // that fixture — this builds its own instead: a root hierarchy page small
  // enough to replace outright, holding one hierarchy-page pointer, and a
  // sub-page under it whose own single named node skips a level (its parent
  // has no entry of its own), forcing one synthesized ancestor when that
  // sub-page is expanded.
  const ROOT_HIER_OFFSET = 81_114_146;
  const ROOT_HIER_LEN = 32;
  const SUBPAGE_OFFSET = 81_114_300;
  const SUBPAGE_LEN = 32;

  /**
   * The real header with only the root hierarchy page's own declared length
   * changed, from the pinned fixture's 8896 bytes down to 32 — enough for
   * the one hierarchy-page-pointer entry this test replaces it with. The
   * field's own byte offset (COPC info VLR content, byte 48) is
   * `copc.js`'s `Info.parse`, not a guess: `src/copc/header.ts` reads the
   * whole 589-byte first read from this same file.
   */
  function headWithSmallRootHierarchy(): Uint8Array {
    const region = new Uint8Array(HEAD);
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
    const headerLength = 375;
    const infoVlrHeaderLength = 54;
    const pageLengthFieldOffset = 48;
    view.setBigUint64(
      headerLength + infoVlrHeaderLength + pageLengthFieldOffset,
      BigInt(ROOT_HIER_LEN),
      true,
    );
    return region;
  }

  // One entry: a page pointer at depth 1, key 1-0-0-0. Depth 0 (the root
  // itself) has no entry of its own, so building this page synthesizes
  // exactly one ancestor tile — the root — matching what
  // `ProviderStats.synthesizedAncestors`'s own baseline should read straight
  // after `fromUrl`.
  const ROOT_HIERARCHY_PAGE = encodeHierarchyPage([
    { key: [1, 0, 0, 0], offset: SUBPAGE_OFFSET, byteSize: SUBPAGE_LEN, pointCount: -1 },
  ]);

  // One entry: a points node at depth 3, key 3-0-0-0, under the hierarchy
  // page's own root (1-0-0-0). Its immediate parent (2-0-0-0) has no entry
  // either, so expanding this sub-page synthesizes two ancestors — its own
  // root (1-0-0-0) and that intermediate (2-0-0-0). offset 0 / byteSize 100
  // is servable without a fixture slice of its own: it lands inside the
  // patched HEAD buffer already registered at file offset 0, and this node's
  // bytes are never decoded, only fetched.
  const SUBPAGE = encodeHierarchyPage([{ key: [3, 0, 0, 0], offset: 0, byteSize: 100, pointCount: 1 }]);

  function contentResourceOf(tile: unknown): Resource {
    return (tile as { _contentResource: Resource })._contentResource;
  }

  /**
   * Builds a provider on the fixture above, then fetches and expands its one
   * hierarchy tile through the codec `fromUrl` actually installed — the
   * same effect a real traversal has once Cesium decides to request that
   * tile. Node has no traversal to drive this any other way, so this calls
   * `createContent` directly, the same way `tests/cesium-codec.test.ts`'s "a
   * hierarchy tile" test does — but against a provider's own real codec and
   * registry, not a constructed stand-in.
   */
  async function buildProviderWithExpandedHierarchyTile(): Promise<{
    provider: COPCTilesetProvider;
    hierarchyResource: Resource;
  }> {
    COPCTilesetProvider.registerCrs(2992, OREGON);
    const { fetch } = fixtureFetch([
      { offset: 0, bytes: headWithSmallRootHierarchy() },
      { offset: 375, bytes: VLRS },
      { offset: ROOT_HIER_OFFSET, bytes: ROOT_HIERARCHY_PAGE },
      { offset: SUBPAGE_OFFSET, bytes: SUBPAGE },
    ]);

    const provider = await COPCTilesetProvider.fromUrl('https://accumulate-host.example/autzen.copc.laz', {
      spawnWorker,
      fetch,
    });

    // The root's only child is the hierarchy-page tile.
    const rootChildren = (provider.tileset.root as unknown as { children: unknown[] }).children;
    expect(rootChildren).toHaveLength(1);
    const hierarchyResource = contentResourceOf(rootChildren[0]);
    const bytes = await hierarchyResource.fetchArrayBuffer();
    expect(bytes).toBeInstanceOf(ArrayBuffer);

    const codec = (
      provider.tileset as unknown as {
        _runtimeContentCodec: { createContent: (...args: unknown[]) => Promise<unknown> };
      }
    )._runtimeContentCodec;
    const fakeTileset = { loadTileset: () => {} };
    const fakeTile = { hasRenderableContent: true, hasTilesetContent: false };
    await codec.createContent(fakeTileset, fakeTile, hierarchyResource, bytes);

    return { provider, hierarchyResource };
  }

  it('grows synthesizedAncestors by the sub-page’s own count, on top of the root page’s baseline', async () => {
    const { provider } = await buildProviderWithExpandedHierarchyTile();

    // 1 (root's own baseline — depth 0 has no entry, only its depth-1 child,
    // the hierarchy pointer, does) + 2 (the sub-page's own two synthesized
    // ancestors) — grown, not replaced.
    expect(provider.stats().synthesizedAncestors).toBe(3);
  });

  it('adds the sub-page’s node to the live registry ScheduledRangeResource reads, not a copy of it', async () => {
    const { hierarchyResource } = await buildProviderWithExpandedHierarchyTile();

    // `InterceptContext.entries`' own doc comment (`resource.ts`) says this
    // map is "held by reference, never copied" so the codec's own later
    // additions stay visible to `ScheduledRangeResource`. This is that claim,
    // proven rather than asserted: derive the sub-page's node URI from the
    // hierarchy tile's own resource URL (same tokenBase prefix, `n/3-0-0-0`
    // instead of `h/1-0-0-0` — the codec added this entry to the registry a
    // moment ago, expanding the page above), then fetch it through a cloned
    // resource. Under the live map this lookup hits; under a copy taken at
    // construction it would miss and reject with `UnknownTileRequestError`
    // (`resource.ts`'s own `fetchArrayBuffer`), because the root page never
    // named this node — only the sub-page did.
    const hierarchyUri = hierarchyResource.url;
    const nodeUri = `${hierarchyUri.slice(0, -'h/1-0-0-0'.length)}n/3-0-0-0`;

    const nodeResource = hierarchyResource.clone();
    nodeResource.url = nodeUri;
    const bytes = await nodeResource.fetchArrayBuffer();

    expect(bytes).toBeInstanceOf(ArrayBuffer);
    // The sub-page's own declared byteSize for this node (encoded above).
    expect((bytes as ArrayBuffer).byteLength).toBe(100);
  });
});
