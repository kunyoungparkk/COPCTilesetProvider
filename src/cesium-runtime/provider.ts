import { Cesium3DTileset, Rectangle } from 'cesium';
import type { Las } from 'copc';
import type { Budget, BudgetStats } from '../budget/index.js';
import { createBudget } from '../budget/index.js';
import type { CopcFile } from '../copc/index.js';
import { openCopc } from '../copc/index.js';
import { findVerticalEpsgCode, registerCrs, resolveCrsDefinition } from '../crs/index.js';
import type { CrsTransform } from '../crs/index.js';
import { createTransformFromDefinition } from '../crs/worker.js';
import { InvalidSourceUrlError, InvalidTokenBaseError } from '../errors/index.js';
import { createRangeReader } from '../range/index.js';
import type { RangeReader, RangeStats } from '../range/index.js';
import { buildTileset, measureRootGeometricError } from '../tileset/index.js';
import type { TileEntry, TilesetContext } from '../tileset/index.js';
import { createWorkerPool, DEFAULT_POOL_SIZE } from '../worker/pool.js';
import type { WorkerPool, WorkerPort } from '../worker/pool.js';
import { createCodec } from './codec.js';
import type { CodecContext } from './codec.js';
import { ScheduledRangeResource } from './resource.js';
import type { InterceptContext } from './resource.js';
import { spawnBundledWorker } from './spawn.js';

/** OVERVIEW §7's default. Cesium's own knob, passed straight through. */
const DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR = 16;

/** The file's root page always describes the octree from this key. */
const ROOT_KEY = { depth: 0, x: 0, y: 0, z: 0 };

/**
 * The method names `PrimitiveCollection` calls on a member it holds
 * (`Scene/PrimitiveCollection.js`), so `scene.primitives.add(provider)` works
 * — declared here, rather than left implicit in which methods the class
 * happens to define, so `tests/cesium-provider-lifetime.test.ts` can compare
 * it against that file's own source and fail on either a name dropped from
 * this list or one added to it that Cesium never calls.
 *
 * @internal Not part of the package's public surface — a Cesium-version-
 * specific contract list, exported only so the test above can read it.
 */
export const DELEGATED_PRIMITIVE_METHODS = [
  'update',
  'updateForPass',
  'prePassesUpdate',
  'postPassesUpdate',
  'destroy',
] as const;

export interface COPCTilesetProviderOptions {
  /** OVERVIEW §7, default 16. Cesium's own knob, passed straight through. */
  readonly maximumScreenSpaceError?: number;
  /** OVERVIEW §7, default 4. */
  readonly workerPoolSize?: number;
  /**
   * How a Worker is made. Optional: without it, `fromUrl` builds one from the
   * Worker bundle inlined into this library (`spawn.ts`).
   *
   * Supply one to escape a `worker-src` CSP that blocks `blob:`, to reuse a
   * Worker you already own, or to run outside a browser — the test suite
   * passes a `node:worker_threads` port this way.
   */
  readonly spawnWorker?: () => WorkerPort;
  /**
   * The transport `createRangeReader` issues every Range request through.
   * Forwarded unchanged; omitting it gets `globalThis.fetch`.
   *
   * A caller supplies one to add auth headers, sign a URL per request, or
   * route through a proxy — whatever it returns still has to satisfy
   * Decision 4: a 206 with a `Content-Range` this library can verify against
   * what it asked for. (Not, despite the shape, a hook that exists only for
   * this library's own tests: `RangeReaderOptions` carries three more §7
   * knobs this option does not forward — `baseTimeoutMs`,
   * `timeoutMsPerMebibyte`, `retryDelaysMs` — because those are tuned, not
   * substituted.)
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Aborts the three reads `fromUrl` makes before it can return
   * (OVERVIEW §4).
   *
   * Cesium's own cancellation does not reach here — there is no tile and no
   * request yet — so this is the caller's channel, for a component unmounted
   * mid-load. Tile requests are cancelled by Cesium instead
   * (`cancellation.ts`), and this signal is not forwarded to them: it would
   * outlive the load it was meant to bound and cancel every later tile.
   */
  readonly signal?: AbortSignal;
  /**
   * The geoid's separation from the WGS84 ellipsoid at this file's location,
   * in metres, added to every height — `h = H + N`, so this is N as geodesy
   * publishes it (negative across North America). Omit it for a file whose Z
   * is already ellipsoidal.
   *
   * One constant, so it is right only over an extent small enough that the
   * separation does not vary across it — a survey site, not a continent. Its
   * accuracy is the caller's to vouch for, the way a registered CRS
   * definition's is (Decision 6).
   */
  readonly geoidHeight?: number;
}

export interface ProviderStats {
  /** `RangeStats`: requests, retries, bytesRequested, bytesWasted, requestsSaved. */
  readonly range: RangeStats;
  /** `BudgetStats`: per-resource admitted/deferred/rejected, current and peak. */
  readonly budget: BudgetStats;
  /**
   * Tiles the synthetic document had to invent outright — a bounding volume,
   * a geometric error, and child links, but no content: a synthesized tile's
   * own `TileNode.entry` is `undefined` (`src/tileset/tree.ts`), so there was
   * never a chunk or a sub-page for it to name. The root page's own count,
   * plus every hierarchy sub-page opened since (Decision 6: a missing
   * ancestor is rebuilt, not refused). A running total, so it can only grow
   * across the life of this provider.
   */
  readonly synthesizedAncestors: number;
  /**
   * Tile descriptors the registry holds right now.
   *
   * It only grows. An entry cannot be dropped: Cesium re-requests an unloaded
   * tile by the same URI, and a missing entry throws
   * `UnknownTileRequestError`, which fails that tile terminally. Bounding this
   * would need an eviction policy keyed on Cesium's content lifecycle, and
   * nothing has measured a need for one — this number is how such a need
   * would first be noticed. OVERVIEW §7 carried a "hierarchy page cache" knob
   * until this replaced it; no parsed page was ever retained for it to bound.
   */
  readonly registryEntries: number;
  /** Hierarchy sub-pages expanded so far. Only grows. */
  readonly hierarchyPagesExpanded: number;
}

/**
 * Checks `TilesetContext.tokenBase`'s contract, documented on that type and
 * enforced nowhere else: absolute with a scheme (Decision 2's first
 * constraint — a relative URI cannot resolve against a Blob URL), ending
 * with `/`, and unchanged by URI normalisation.
 *
 * The provider is `tokenBase`'s only caller: it generates the value fresh for
 * every `fromUrl` (making stability and per-provider uniqueness true by
 * construction) and is the one place positioned to check the rest. A named,
 * exported function rather than an inline check because that generator can
 * never itself hand this a bad value — the only way to exercise a rejection
 * is to call this directly with one.
 */
export function validateTokenBase(tokenBase: string): void {
  let url: URL;
  try {
    url = new URL(tokenBase);
  } catch {
    throw new InvalidTokenBaseError(tokenBase, 'must be an absolute URI with a scheme');
  }
  if (!tokenBase.endsWith('/')) {
    throw new InvalidTokenBaseError(tokenBase, 'must end with "/"');
  }
  if (url.href !== tokenBase) {
    throw new InvalidTokenBaseError(
      tokenBase,
      `must survive URI normalisation unchanged (parsed back as ${JSON.stringify(url.href)})`,
    );
  }
}

// A per-process counter, not just `Math.random()` alone: two calls in the
// same microtask can draw the same float from `Math.random()` on some
// engines, and this only needs to be unique among providers in this one
// process, not globally unpredictable.
let tokenBaseSequence = 0;

/**
 * A fresh `copc://` prefix, unique per call. `validateTokenBase` checks the
 * shape this always produces.
 *
 * Not `crypto.randomUUID()`: that method is undefined on a plain-HTTP origin
 * that is not `localhost` (the Web Crypto API's own secure-context
 * restriction), which would throw a bare `TypeError` out of `fromUrl` before
 * any typed error could fire — and `tokenBase` needs only uniqueness within
 * this process, not cryptographic unpredictability.
 */
function createTokenBase(): string {
  tokenBaseSequence += 1;
  return `copc://${tokenBaseSequence.toString(36)}-${Math.random().toString(36).slice(2)}/`;
}

/**
 * The header's own measured min/max corners, transformed to WGS84 —
 * Decision 6's camera-framing extent. Unlike a tile's `region` boundingVolume
 * (`src/tileset/region.ts`), this is not a data-containment guarantee, only a
 * caller's `flyTo` target, so the four corners are enough: no edge-curvature
 * padding.
 */
function measureExtent(
  header: Pick<CopcFile['header'], 'min' | 'max'>,
  transform: CrsTransform,
): Rectangle {
  const [minX, minY] = header.min;
  const [maxX, maxY] = header.max;

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [x, y] of [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ] as const) {
    const [longitude, latitude] = transform.toWgs84(x, y, 0);
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return Rectangle.fromDegrees(west, south, east, north);
}

/**
 * Says so, once, when a file measures height from a geoid and the caller gave
 * nothing to correct it with.
 *
 * A warning rather than a typed error, which is where this parts company with
 * Decision 6's treatment of an unregistered horizontal CRS. The asymmetry is
 * deliberate: an unresolvable horizontal system leaves the points nowhere at
 * all, while an uncorrected height leaves them somewhere wrong by a knowable
 * amount — and refusing the file would strand a caller who does not know N.
 *
 * The message follows the same rule the errors do: it names what was found and
 * the call to paste. The centre comes from the header so the caller has the
 * coordinates to look N up with, and no particular service is named — which
 * one is right depends on the country the data is in.
 */
function warnIfHeightsAreUncorrected(
  wkt: string | undefined,
  geoidHeight: number | undefined,
  // The same slice `measureRootGeometricError` takes, for the same reason:
  // the extent is all this needs, and naming it says so.
  header: Pick<Las.Header, 'min' | 'max'>,
  transform: CrsTransform,
): void {
  // `wkt === undefined` is not a defensive check against an impossible case
  // (this codebase forbids those) — it is type narrowing, because
  // `findVerticalEpsgCode` takes `string` and `file.wkt` is `string | undefined`.
  if (geoidHeight !== undefined || wkt === undefined) {
    return;
  }
  const code = findVerticalEpsgCode(wkt);
  if (code === null) {
    return;
  }

  const [minX, minY] = header.min;
  const [maxX, maxY] = header.max;
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const [longitude, latitude] = transform.toWgs84(centreX, centreY, 0);

  console.warn(
    `copc-tileset-provider: this file declares vertical CRS EPSG:${code}, which measures ` +
      `height from a geoid, but no geoidHeight was given. Its points will be off by the geoid ` +
      `separation at this location (worldwide, roughly -107 m to +85 m). Look up the geoid ` +
      `height N at this dataset's centre (${latitude.toFixed(4)}, ${longitude.toFixed(4)}) and ` +
      `pass it in metres:\n\n  COPCTilesetProvider.fromUrl(url, { geoidHeight: N })\n\n` +
      `A file whose heights are already ellipsoidal silences this with geoidHeight: 0.`,
  );
}

/**
 * Assembles everything `src/copc/`, `src/crs/`, `src/tileset/`,
 * `src/worker/` and `src/budget/` build into the one primitive
 * `scene.primitives.add(...)` takes (OVERVIEW §1).
 *
 * `tileset` and `extent` are exposed directly — styling, picking and
 * traversal stay Cesium's (Decision 1), and camera framing is the caller's
 * own call to make.
 */
export class COPCTilesetProvider {
  readonly tileset: Cesium3DTileset;
  readonly extent: Rectangle;

  readonly #rangeReader: RangeReader;
  readonly #budget: Budget;
  readonly #workerPool: WorkerPool;
  readonly #synthesizedAncestors: { count: number };
  readonly #entries: ReadonlyMap<string, TileEntry>;
  readonly #hierarchyPagesExpanded: { count: number };
  readonly #blobUrl: string;
  #destroyed = false;

  private constructor(init: {
    tileset: Cesium3DTileset;
    extent: Rectangle;
    rangeReader: RangeReader;
    budget: Budget;
    workerPool: WorkerPool;
    synthesizedAncestors: { count: number };
    entries: ReadonlyMap<string, TileEntry>;
    hierarchyPagesExpanded: { count: number };
    blobUrl: string;
  }) {
    this.tileset = init.tileset;
    this.extent = init.extent;
    this.#rangeReader = init.rangeReader;
    this.#budget = init.budget;
    this.#workerPool = init.workerPool;
    this.#synthesizedAncestors = init.synthesizedAncestors;
    this.#entries = init.entries;
    this.#hierarchyPagesExpanded = init.hierarchyPagesExpanded;
    this.#blobUrl = init.blobUrl;
  }

  /**
   * Teaches this process one coordinate system (Decision 6). A static method
   * because it must be callable before `fromUrl` even exists — the README's
   * first example is written `registerCrs` then `fromUrl`, to document that
   * order.
   */
  static registerCrs(code: number, definition: string): void {
    registerCrs(code, definition);
  }

  /**
   * Opens a COPC file and returns the primitive that streams it.
   *
   * The order follows OVERVIEW §4 and Decision 2: a reader and a budget; the
   * three requests `openCopc` needs; the file's coordinate system, resolved
   * here on the main thread because its two failure modes
   * (`CrsCodeNotFoundError`, `CrsNotRegisteredError`) have to reject this
   * call rather than surface inside a Worker that holds none of what a
   * caller registered; the root geometric error and a fresh `tokenBase`; the
   * synthetic tileset document and its registry; a Blob URL for that
   * document, fetched through a `ScheduledRangeResource` so Cesium's own
   * `getDerivedResource`/`clone` keep every tile's content resource inside
   * this class rather than downgrading to a plain `Resource` (see that
   * class's own doc); and finally the codec that turns tile bytes into
   * content.
   */
  static async fromUrl(
    url: string,
    // Defaulted, not merely optional-per-field: `fromUrl(url)` is the one-line
    // call OVERVIEW §1 promises, and every field below now has a default.
    options: COPCTilesetProviderOptions = {},
  ): Promise<COPCTilesetProvider> {
    // First, before a single request: `ScheduledRangeResource` needs this
    // URL's origin for the per-origin budget and computes it with `new
    // URL(...)`, which throws a bare `TypeError: Invalid URL` on a relative
    // one — but only after the three reads below have already succeeded, so
    // the cost of that failure is three round trips and the message names
    // neither the URL nor anything a caller can branch on (Decision 6).
    if (!URL.canParse(url)) {
      throw new InvalidSourceUrlError(url);
    }

    // A conditional spread rather than `{ fetch: options.fetch }`:
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as a
    // different thing from an absent key, and `RangeReaderOptions.fetch` only
    // accepts the latter.
    const reader = createRangeReader(url, {
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
    // OVERVIEW §7 sets the decode budget at pool size x 2, so it has to follow
    // the pool size this provider was actually given. `createBudget()` with no
    // limits uses a literal 8 — right for the default pool of 4 and wrong for
    // every other value, which would throttle a pool below the concurrency it
    // was asked for.
    const workerPoolSize = options.workerPoolSize ?? DEFAULT_POOL_SIZE;
    const budget = createBudget({ decodeJobs: workerPoolSize * 2 });

    const file = await openCopc(reader, options.signal);

    const definition = resolveCrsDefinition(file.wkt);
    const transform = createTransformFromDefinition(definition, options.geoidHeight);

    warnIfHeightsAreUncorrected(file.wkt, options.geoidHeight, file.header, transform);

    const rootGeometricError = measureRootGeometricError(file.header, transform);

    const tokenBase = createTokenBase();
    validateTokenBase(tokenBase);

    const tilesetContext: Omit<TilesetContext, 'rootKey'> = {
      url,
      tokenBase,
      cube: file.info.cube,
      rootGeometricError,
      transform,
    };
    const built = buildTileset(file.root, { ...tilesetContext, rootKey: ROOT_KEY });

    // The one copy this registry ever takes: `buildTileset`'s own return
    // value is typed `ReadonlyMap` and is not shared with anything yet.
    // Every context built from here on — `InterceptContext.entries`,
    // `CodecContext.entries` — holds this exact `Map` by reference, which is
    // what lets the codec's own later additions (a sub-page's entries) stay
    // visible through both.
    const entries = new Map<string, TileEntry>(built.entries);

    // Boxed so the codec (`CodecContext.synthesizedAncestors`) and this
    // provider's own `stats()` hold the same mutable counter: a sub-page's
    // own count adds to this object as hierarchy tiles expand, rather than
    // being lost the way discarding `buildTileset`'s per-call return value
    // would lose it.
    const synthesizedAncestors = { count: built.synthesizedAncestors };
    // Boxed for the same reason, and counted here rather than derived from
    // `entries`: a page can contribute no new entry at all (every key already
    // known), so the two numbers answer different questions.
    const hierarchyPagesExpanded = { count: 0 };

    const interceptContext: InterceptContext = {
      reader,
      budget,
      entries,
      tokenBase,
      url,
    };

    const blobUrl = URL.createObjectURL(
      new Blob([JSON.stringify(built.json)], { type: 'application/json' }),
    );
    const resource = new ScheduledRangeResource({ url: blobUrl }, interceptContext);

    let tileset: Cesium3DTileset;
    try {
      tileset = await Cesium3DTileset.fromUrl(resource, {
        // Decision 1: ADD refinement already carries full resolution at
        // every depth, so there is no redundant coarser level for this
        // optimization to skip past — left at Cesium's own default.
        skipLevelOfDetail: false,
        maximumScreenSpaceError: options.maximumScreenSpaceError ?? DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR,
      });
    } finally {
      // Revoked only now: Cesium has already awaited the JSON by the time
      // `fromUrl` resolves (or throws), so nothing still needs this Blob URL
      // to be valid, and revoking earlier would race the fetch it exists
      // for (OVERVIEW §4).
      URL.revokeObjectURL(blobUrl);
    }

    // Built only now, after the tileset exists: spawning is lazy (nothing is
    // spawned until the first decode job), so there is nothing to destroy
    // yet regardless — but if `Cesium3DTileset.fromUrl` above had thrown, a
    // pool built any earlier would be unreachable and undestroyable, since
    // no provider is ever returned to hold it.
    const workerPool = createWorkerPool({
      spawn: options.spawnWorker ?? spawnBundledWorker,
      definition,
      // Conditional spread for the same `exactOptionalPropertyTypes` reason as
      // the `fetch` one above.
      ...(options.geoidHeight !== undefined && { geoidHeight: options.geoidHeight }),
      budget,
      size: workerPoolSize,
    });

    // Decision 2's second constraint: the codec branch skips Cesium's own
    // content classification, so nothing sets `_runtimeContentCodec` but us.
    (tileset as unknown as { _runtimeContentCodec: unknown })._runtimeContentCodec = createCodec({
      workerPool,
      header: file.header,
      filePointCount: file.header.pointCount,
      entries,
      tilesetContext,
      synthesizedAncestors,
      hierarchyPagesExpanded,
    } satisfies CodecContext);

    return new COPCTilesetProvider({
      tileset,
      extent: measureExtent(file.header, transform),
      rangeReader: reader,
      budget,
      workerPool,
      synthesizedAncestors,
      entries,
      hierarchyPagesExpanded,
      blobUrl,
    });
  }

  /**
   * §7's live tuning numbers: the Range merge's real waste ratio
   * (`bytesWasted`/`bytesRequested`), and each budget resource's
   * admitted/deferred/rejected counts.
   */
  stats(): ProviderStats {
    return {
      range: this.#rangeReader.stats(),
      budget: this.#budget.stats(),
      synthesizedAncestors: this.#synthesizedAncestors.count,
      registryEntries: this.#entries.size,
      hierarchyPagesExpanded: this.#hierarchyPagesExpanded.count,
    };
  }

  /**
   * `scene.primitives.add(provider)` works because this class implements
   * every name in `DELEGATED_PRIMITIVE_METHODS`, above. The four casts below
   * exist because `cesium`'s `.d.ts` marks these methods `@ignore` and does
   * not declare any of them on `Cesium3DTileset` — the same situation
   * `codec.ts`'s `CesiumContentFactories` is in, and for the same reason: a
   * static, typed reference to a method Cesium's own public types omit
   * cannot be written without one.
   *
   * Every one of the four update hooks below is a no-op once `destroy()` has
   * run, rather than forwarding into `tileset`. Measured directly
   * (`tests/cesium-provider-lifetime.test.ts`): Cesium's own
   * `Cesium3DTileset.destroy()` ends in `destroyObject`, which replaces every
   * one of `tileset`'s methods with a stub that throws `DeveloperError`. A
   * caller who removes this provider from `scene.primitives` before
   * destroying it never reaches this — `PrimitiveCollection` itself stops
   * calling a member it no longer holds — but nothing stops a caller from
   * destroying this provider directly while it is still in the scene, and
   * `Scene` keeps calling `update` on every primitive it holds, every frame,
   * whether or not that primitive is destroyed. Forwarding into the
   * destroyed `tileset` would throw that `DeveloperError` from inside
   * Cesium's own render loop on every one of those frames; a no-op instead
   * leaves the primitive merely inert.
   */
  update(frameState: unknown): void {
    if (this.#destroyed) {
      return;
    }
    (this.tileset as unknown as { update(frameState: unknown): void }).update(frameState);
  }

  /** See `update`'s own doc comment for the post-`destroy()` behaviour this shares. */
  updateForPass(frameState: unknown, passState: unknown): void {
    if (this.#destroyed) {
      return;
    }
    (
      this.tileset as unknown as { updateForPass(frameState: unknown, passState: unknown): void }
    ).updateForPass(frameState, passState);
  }

  /** See `update`'s own doc comment for the post-`destroy()` behaviour this shares. */
  prePassesUpdate(frameState: unknown): void {
    if (this.#destroyed) {
      return;
    }
    (this.tileset as unknown as { prePassesUpdate(frameState: unknown): void }).prePassesUpdate(
      frameState,
    );
  }

  /** See `update`'s own doc comment for the post-`destroy()` behaviour this shares. */
  postPassesUpdate(frameState: unknown): void {
    if (this.#destroyed) {
      return;
    }
    (this.tileset as unknown as { postPassesUpdate(frameState: unknown): void }).postPassesUpdate(
      frameState,
    );
  }

  /**
   * Releases everything Cesium does not own and does not know exists: the
   * tileset itself, the Worker pool, the budget, and the synthetic tileset
   * document's Blob URL. Idempotent — a second call is a no-op, which is what
   * makes it safe for both a caller's own explicit call and
   * `PrimitiveCollection#destroy`/`remove` to each call it once without
   * coordinating with the other.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;

    // Every release below runs whatever the ones before it did, and the
    // first error is rethrown only once they all have. Not defensive
    // symmetry: `tileset` is public by design, so a caller can destroy it
    // itself — `scene.primitives.add(provider.tileset)` puts it in
    // `PrimitiveCollection`'s hands too — and Cesium's `destroyObject`
    // replaces every method on a destroyed object with a stub that throws
    // `DeveloperError`. A plain sequence would end there, leaving the Worker
    // pool, its threads and their WASM instances unreachable for the life of
    // the page while `isDestroyed()` reported success. The `isDestroyed()`
    // guard is that case specifically; the loop is what keeps the other
    // three from depending on it.
    let firstError: { thrown: unknown } | undefined;
    for (const release of [
      () => {
        if (!this.tileset.isDestroyed()) {
          this.tileset.destroy();
        }
      },
      () => {
        this.#workerPool.destroy();
      },
      () => {
        this.#budget.destroy();
      },
      // Already revoked by the time this instance exists: `fromUrl`'s own
      // `finally` revokes this Blob URL as soon as `Cesium3DTileset.fromUrl`
      // settles, success or failure, because nothing needs it valid past
      // that point. Revoking an already-revoked URL is specified as a no-op,
      // so this costs nothing — it exists so "destroy() releases every
      // resource this class allocated" stays true here alone, without
      // depending on that other method's ordering.
      () => {
        URL.revokeObjectURL(this.#blobUrl);
      },
    ]) {
      try {
        release();
      } catch (thrown) {
        // Boxed rather than assigned directly: a thrown `undefined` is legal
        // JavaScript, and `firstError ??=` on the bare value would let the
        // next failure overwrite it.
        firstError ??= { thrown };
      }
    }
    if (firstError !== undefined) {
      throw firstError.thrown;
    }
  }

  /**
   * True once `destroy()` has run. Cesium's own convention for a primitive
   * (`PrimitiveCollection#isDestroyed`) — but only half of it: that JSDoc
   * also says calling anything other than `isDestroyed` on a destroyed
   * primitive throws a `DeveloperError`, and the four hooks above
   * deliberately do not (see `update`'s own doc comment for why). This
   * method keeps the query half of the convention; the throwing half is the
   * trade this class declines.
   */
  isDestroyed(): boolean {
    return this.#destroyed;
  }
}
