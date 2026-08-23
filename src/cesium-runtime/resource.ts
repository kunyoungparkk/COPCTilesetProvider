import { Resource } from 'cesium';
import type { Budget, Lease } from '../budget/index.js';
import { RangeRequestRejectedError, UnknownTileRequestError } from '../errors/index.js';
import type { RangeReader } from '../range/index.js';
import type { TileEntry } from '../tileset/index.js';
import { signalForRequest } from './cancellation.js';

/**
 * Everything `ScheduledRangeResource` needs to answer a tile request, handed
 * in by the provider that constructs it.
 */
export interface InterceptContext {
  readonly reader: RangeReader;
  readonly budget: Budget;
  /**
   * The provider's live registry. Held by reference, never copied: the codec
   * adds to this map as sub-pages open, and a copy would make every entry
   * after the root page invisible — a defect that would surface one task later
   * and look like the codec's.
   */
  readonly entries: ReadonlyMap<string, TileEntry>;
  /**
   * The provider's own URI prefix. Its *scheme* is what distinguishes "ours
   * but unknown" from "not ours at all" — see `#scheme` below.
   */
  readonly tokenBase: string;
  /** The COPC file's own URL — the origin `acquireRangeRequest` admits against. */
  readonly url: string;
}

/**
 * Intercepts Cesium's tile requests and answers them with the budget's own
 * verdict, instead of letting `copc://…` tokens reach the network.
 *
 * Two Cesium internals this class exists to survive, both measured against
 * the installed 1.143.0 source (`Core/Resource.js`, `Scene/Cesium3DTile.js`):
 *
 * 1. Every tile's content resource is derived from the tileset's own resource
 *    (`baseResource.getDerivedResource(...)`), which routes through `clone`.
 *    `Resource.prototype.clone` builds a **plain** `Resource` when handed no
 *    result, so a subclass that does not override `clone` is downgraded
 *    before its first use — see the override below.
 * 2. A tile's content resource is only ever this class because the *base*
 *    resource handed to `Cesium3DTileset.fromUrl` is: `getDerivedResource`
 *    and `Resource.createIfNeeded` both route through `clone`, and cloning
 *    is what makes a derived resource's class follow the base's. That base
 *    resource is not used for tile content alone, though — its own tileset
 *    JSON, for one, loads through `Resource.prototype.fetchJson`
 *    (`Cesium3DTileset.loadJson` calling `resource.fetchJson()`,
 *    `Scene/Cesium3DTileset.js:2313-2315`), a method this class never
 *    overrides. Delegating every miss to `super.fetchArrayBuffer()` is what
 *    keeps being forced into this class from narrowing anything else the
 *    resource is asked to do.
 */
export class ScheduledRangeResource extends Resource {
  #context: InterceptContext;
  /**
   * The host `acquireRangeRequest` admits against, computed once here rather
   * than on every `fetchArrayBuffer()` call. `new URL(...)` throws on a
   * relative URL, and Cesium calls `fetchArrayBuffer()` with no `try` around
   * it (`Cesium3DTile.prototype.requestContent`), so a per-request
   * computation would surface that throw inside traversal. `fromUrl` refuses
   * a relative URL before constructing this (`InvalidSourceUrlError`), which
   * leaves this line unreachable by that route — it stays a construction-time
   * computation because nothing about a resource's origin changes per
   * request, not as a second guard.
   */
  #origin: string;
  /**
   * `tokenBase`'s own scheme, with its colon — `copc:`. Taken from
   * `tokenBase` rather than written out as a literal, so the two cannot
   * drift apart, and computed once here for the same reason `#origin` is.
   *
   * The scheme rather than the whole of `tokenBase` is what
   * `fetchArrayBuffer` gates on: `tokenBase` is unique per provider, so a
   * `copc://…` URI minted by a *different* provider does not start with this
   * one's and would fall through to `super.fetchArrayBuffer()` — a real
   * network attempt on a URI that names nothing on any network. Every
   * provider mints under this scheme, so the scheme is the honest boundary
   * for "this library's own, and never to be fetched".
   */
  #scheme: string;

  constructor(options: { url: string }, context: InterceptContext) {
    super(options);
    this.#context = context;
    this.#origin = new URL(context.url).origin;
    this.#scheme = new URL(context.tokenBase).protocol;
  }

  /**
   * Keeps derived resources in this class.
   *
   * `Resource.prototype.clone` builds a plain `Resource` when handed no
   * result, and Cesium derives every tile's content resource from the
   * tileset's (`Cesium3DTile.js`, `baseResource.getDerivedResource(...)`) and
   * clones it again before each request. Without this override the
   * interception is gone before the first tile, and `copc://…` reaches the
   * network. `IonResource` (`Core/IonResource.js:175-191`) overrides `clone`
   * for the same reason: build itself when `result` is missing, delegate to
   * `Resource.prototype.clone`, then restore the field the base class knows
   * nothing about.
   *
   * The `result` parameter exists to satisfy `Resource`'s own signature, not
   * because anything in Cesium supplies one: every call site that clones a
   * resource in this codebase — `getDerivedResource`, `Resource.createIfNeeded`,
   * and every `tile._contentResource.clone()` / `baseResource.clone()` /
   * `resource.clone()` in `Cesium3DTile.js` and `Cesium3DTileset.js` — calls
   * `clone()` with no argument. If a caller ever did pass a `result` that is
   * not itself a `ScheduledRangeResource` (a plain `Resource`, say), copying
   * `#context` onto it below throws — private fields reject writes on an
   * object whose class never declared them — rather than silently producing
   * a resource with the wrong behaviour.
   */
  override clone(result?: Resource): Resource {
    const target = result ?? new ScheduledRangeResource({ url: this.url }, this.#context);
    const cloned = Resource.prototype.clone.call(this, target) as ScheduledRangeResource;
    cloned.#context = this.#context;
    cloned.#origin = this.#origin;
    cloned.#scheme = this.#scheme;
    return cloned;
  }

  /**
   * Answers a request with the budget's verdict, mapped onto the contract
   * `requestSingleContent` (`Cesium3DTile.js:1300-1330`) already defines for
   * whatever `fetchArrayBuffer` returns — its own JSDoc: *"or undefined if
   * the request cannot be scheduled this frame"*: `admitted` reads through
   * the reader, `deferred` returns `undefined` so Cesium re-asks next frame
   * without marking the tile failed, and `rejected` returns a rejected
   * promise, which is what a permanent refusal has to mean to a caller that
   * only has these two states.
   *
   * A URL this registry has no entry for splits on its scheme. Outside
   * `tokenBase`'s scheme it is something Cesium genuinely wants fetched —
   * the tileset's own base resource being asked for something other than
   * tile content, say (see the class doc above) — and goes to
   * `super.fetchArrayBuffer()`. Inside it, some provider minted the URI and
   * no provider can answer it, so a miss is not a guess to fill in
   * (Decision 4) but a bug, and fails with a typed error instead of
   * reaching the network.
   */
  override fetchArrayBuffer(): Promise<ArrayBuffer> | undefined {
    const { entries, budget, reader } = this.#context;
    const entry = entries.get(this.url);

    if (entry === undefined) {
      if (this.url.startsWith(this.#scheme)) {
        return Promise.reject(new UnknownTileRequestError(this.url));
      }
      return super.fetchArrayBuffer();
    }

    const admission = budget.acquireRangeRequest(this.#origin, entry.length);

    if (admission.verdict === 'deferred') {
      // Nothing was acquired, so there is nothing to release.
      return undefined;
    }
    if (admission.verdict === 'rejected') {
      return Promise.reject(new RangeRequestRejectedError(this.url, admission.reason));
    }

    // Cesium assigned `this.request` immediately before calling this
    // (`Cesium3DTile.js`, `requestSingleContent`), so this is the object its
    // own `cancelRequests()` cancels. Aborting the read is safe: Cesium's
    // catch around the request promise checks `request.cancelled` and puts
    // the tile back to its previous state rather than failing it.
    const signal = signalForRequest((this as { request?: unknown }).request);
    return ScheduledRangeResource.#readAdmitted(reader, entry, admission.lease, signal);
  }

  /**
   * Reads an admitted request and releases its lease exactly once, however
   * the read ends. A `finally` rather than a `.then(onFulfilled, onRejected)`
   * pair: `RangeReader` is a public interface, so nothing here can assume
   * `read` is `async` (the shipped one is, `range-reader.ts:297`, but the
   * type does not require it) — a `.then` pair cannot see a synchronous
   * throw, while a synchronous throw inside this `async` method's body is
   * still caught by `finally` the same as a rejected promise would be.
   */
  static async #readAdmitted(
    reader: RangeReader,
    entry: TileEntry,
    lease: Lease,
    signal: AbortSignal | undefined,
  ): Promise<ArrayBuffer> {
    try {
      const { bytes } = await reader.read({ offset: entry.offset, length: entry.length }, signal);
      return bytes;
    } finally {
      lease.release();
    }
  }
}
