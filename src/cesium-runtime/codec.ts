import type { Resource } from 'cesium';
import { parseHierarchyPage } from '../copc/index.js';
import { UnknownTileRequestError } from '../errors/index.js';
import type { TileEntry, TilesetContext } from '../tileset/index.js';
import { buildTileset } from '../tileset/index.js';
import type { DecodeHeader } from '../worker/index.js';
import type { WorkerPool } from '../worker/pool.js';

/**
 * The two tile flags `Cesium3DTile.makeContent` leaves to the codec.
 *
 * `Scene/Cesium3DTile.js:1372-1383` awaits `codec.createContent(...)` and
 * returns immediately after — before `preprocess3DTileContent`, the call that
 * would otherwise set both flags. A real `Cesium3DTile` carries many more
 * fields than these two, but they are the only ones this module ever reads or
 * writes, so they are the only ones named here.
 */
export interface CesiumTileFlags {
  hasRenderableContent: boolean;
  hasTilesetContent: boolean;
}

/**
 * The shape `Cesium3DTileset.js:772-786` documents for `_runtimeContentCodec`.
 * `contentType` is documented there as diagnostic only — nothing in
 * `Cesium3DTile.js`'s codec branch reads it — so its value is not a contract,
 * only a label a caller inspecting the installed codec would see.
 */
export interface RuntimeContentCodec {
  readonly contentType: string;
  createContent(
    tileset: unknown,
    tile: CesiumTileFlags,
    resource: Resource,
    arrayBuffer: ArrayBuffer,
  ): Promise<unknown>;
}

/** Everything `createCodec` needs, independent of which tile it is asked about. */
export interface CodecContext {
  readonly workerPool: WorkerPool;
  /** The whole file's record layout and scale/offset — every point tile decodes against it. */
  readonly header: DecodeHeader;
  /** The file header's own point count, `readHierarchyPage`'s bound on a sub-page's own entries. */
  readonly filePointCount: number;
  /**
   * The provider's live registry, held by reference and mutated here as
   * sub-pages open. `ScheduledRangeResource` holds the same object through
   * `InterceptContext.entries`, typed there as a `ReadonlyMap` — one object,
   * two views, so an entry this module adds is visible through the other the
   * moment it is set.
   */
  readonly entries: Map<string, TileEntry>;
  /**
   * Everything `buildTileset` needs beyond the one field that changes per
   * hierarchy tile: `rootKey`. Re-entering `buildTileset` with `rootKey` set
   * to the expanding entry's own key is how a hierarchy page becomes an
   * external tileset — the same function that built the file's root page,
   * not a second builder.
   */
  readonly tilesetContext: Omit<TilesetContext, 'rootKey'>;
  /**
   * The running total of synthesized-ancestor tiles across every hierarchy
   * page built so far — the root page's own count, plus each sub-page's as
   * it opens. A boxed counter, held by reference the same way `entries` is,
   * so `stats()` (`provider.ts`) reads the live total through the one object
   * this module keeps adding to, not a snapshot taken at construction.
   */
  readonly synthesizedAncestors: { count: number };
}

/**
 * Cesium's `Model3DTileContent.fromPnts` and `Tileset3DTileContent.fromJson`,
 * reached the way `tests/cesium-contract.test.ts` reaches them: through the
 * declared `cesium` peer's own runtime exports, not the undeclared
 * `@cesium/engine` package. Both are absent from `cesium`'s `.d.ts` — a
 * static import would fail typecheck (TS7016) — which is what the dynamic
 * import and cast are for, not a preference for one style over another.
 */
interface CesiumContentFactories {
  readonly Model3DTileContent: {
    fromPnts(
      tileset: unknown,
      tile: unknown,
      resource: Resource,
      arrayBuffer: ArrayBuffer,
      byteOffset: number,
    ): Promise<unknown>;
  };
  readonly Tileset3DTileContent: {
    fromJson(tileset: unknown, tile: unknown, resource: Resource, json: unknown): unknown;
  };
}

const importCesium = (): Promise<unknown> => import('cesium');

/**
 * Builds a memoizing loader for Cesium's content-construction factories.
 *
 * The cache lives in the returned closure rather than at module scope, so
 * one belongs to each codec. That is what a codec needs — every tile it
 * builds awaits nothing after the first — and it is all it needs: a second
 * provider on the same page pays one already-resolved microtask on its own
 * first tile, because `import()` of a loaded module resolves from the module
 * registry regardless. A process-wide cache would buy that microtask back
 * and cost a shared mutable slot every test would have to work around.
 *
 * `load` defaults to the real dynamic import and is a parameter so a test can
 * substitute one that fails on demand, to exercise the `.catch` below without
 * making `cesium`'s own import fail.
 */
export function createContentFactoryLoader(
  load: () => Promise<unknown> = importCesium,
): () => Promise<CesiumContentFactories> {
  let cached: Promise<CesiumContentFactories> | undefined;

  return () => {
    if (cached !== undefined) {
      return cached;
    }
    const promise = (async () => (await load()) as unknown as CesiumContentFactories)().catch(
      (error: unknown) => {
        // A rejected promise is still a cached value, so without this the
        // first failure would poison the slot forever and every later tile
        // would await the same dead promise, never calling `load` again.
        // Clearing it here is what makes a transient failure — a code-split
        // chunk request failing once, say — recoverable on the next call
        // rather than permanent.
        cached = undefined;
        throw error;
      },
    );
    cached = promise;
    return promise;
  };
}

/**
 * Installs the codec `Cesium3DTileset._runtimeContentCodec` delegates to for
 * every tile's content (OVERVIEW §3, Decision 2).
 *
 * The codec branches on `entry.kind`, never on the URI's `n/` versus `h/`
 * prefix: the two are redundant encodings of the same fact, and only `kind`
 * is what the registry actually promises.
 */
export function createCodec(context: CodecContext): RuntimeContentCodec {
  const loadContentFactories = createContentFactoryLoader();

  return {
    contentType: 'copc',

    async createContent(tileset, tile, resource, arrayBuffer) {
      const entry = context.entries.get(resource.url);
      if (entry === undefined) {
        throw new UnknownTileRequestError(resource.url);
      }

      const { Model3DTileContent, Tileset3DTileContent } = await loadContentFactories();

      if (entry.kind === 'points') {
        // `ScheduledRangeResource` maps the budget's `deferred` verdict onto
        // Cesium's own `undefined`-means-"ask again next frame" contract for
        // a Range *request* — a channel Cesium gives it
        // (`Cesium3DTile.js:1300-1330`). `createContent` has no equivalent
        // channel: it must resolve to a `Cesium3DTileContent`, and a tile
        // that fails here goes straight to `Cesium3DTileContentState.FAILED`
        // with no way back — Cesium's own cache only ever adds a tile once
        // its content is ready, so a FAILED tile is never eligible for
        // `unloadTile`, the one path back to UNLOADED. `encodeWhenAdmitted`
        // is where that difference is handled: it waits out a transient
        // `deferred` verdict instead of returning it, and only a permanent
        // `rejected` verdict reaches this `await` as a throw.
        const pnts = await context.workerPool.encodeWhenAdmitted({
          compressed: arrayBuffer,
          header: context.header,
          pointCount: entry.pointCount,
        });

        // Belt-and-braces, not load-bearing: a real `Cesium3DTile` with a
        // content URI already defaults this to `true`
        // (`Cesium3DTile.js:337`, `this.hasRenderableContent =
        // !hasEmptyContent`). The hierarchy branch below is the one that
        // actually changes Cesium's default.
        tile.hasRenderableContent = true;
        return Model3DTileContent.fromPnts(tileset, tile, resource, pnts, 0);
      }

      const page = parseHierarchyPage(context.tilesetContext.url, arrayBuffer, context.filePointCount);
      const built = buildTileset(page, { ...context.tilesetContext, rootKey: entry.key });
      for (const [uri, subEntry] of built.entries) {
        context.entries.set(uri, subEntry);
      }
      context.synthesizedAncestors.count += built.synthesizedAncestors;

      // Left to the codec because the early return above skips the branch in
      // `Cesium3DTile.js` that would otherwise set them
      // (`preprocess3DTileContent`'s `EXTERNAL_TILESET` case). Miss
      // `hasTilesetContent` and this subtree never opens.
      //
      // Decision 2's second constraint names four things that early return
      // leaves to the codec: these two flags, `content.metadata` and
      // `content.group`. This codec sets the two flags and neither of the
      // other two — a gap between the constitution and the code, recorded
      // here rather than closed, because for the document this library emits
      // the two are equivalent to what Cesium would have done. Measured
      // against the installed 1.143.0: on the non-codec path `content.metadata`
      // comes from `findContentMetadata`, which returns `undefined` unless
      // the tile's own content header carries a `metadata` field or a
      // `3DTILES_metadata` extension; `content.group` is assigned only when
      // `findGroupMetadata` returns something, and that returns `undefined`
      // unless the tileset carries a `metadataExtension`. `src/tileset/build.ts`
      // emits none of the three, and `Model3DTileContent` and
      // `Tileset3DTileContent` both initialise `_metadata` and `_group` to
      // `undefined` in their constructors — so assigning them here would
      // write the values they already hold. The day the synthetic document
      // grows metadata, that stops being true.
      tile.hasTilesetContent = true;
      tile.hasRenderableContent = false;
      return Tileset3DTileContent.fromJson(tileset, tile, resource, built.json);
    },
  };
}
