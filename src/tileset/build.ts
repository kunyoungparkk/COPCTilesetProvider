import type { Bounds } from 'copc';
import type { HierarchyPage, NodeKey } from '../copc/index.js';
import type { CrsTransform } from '../crs/index.js';
import { geometricErrorAtDepth } from './geometric-error.js';
import type { Region } from './region.js';
import { regionForKey } from './region.js';
import type { TileEntry, TileNode } from './tree.js';
import { buildTileTree, keyText } from './tree.js';

/** The subset of a 3D Tiles 1.0 document this module emits. */
export interface TilesetJson {
  readonly asset: { readonly version: '1.0' };
  readonly geometricError: number;
  readonly root: TileJson;
}

export interface TileJson {
  readonly boundingVolume: { readonly region: Region };
  readonly geometricError: number;
  readonly refine?: 'ADD';
  readonly content?: { readonly uri: string };
  readonly children?: readonly TileJson[];
}

export interface TilesetContext {
  /** The file being described. Errors name it, as everywhere else in the library. */
  readonly url: string;
  /**
   * Absolute URI prefix every tile's content URI is built on.
   *
   * The caller owns the scheme because the caller owns the interception.
   * Contract: absolute — a scheme is required, since Decision 2's first
   * constraint is that relative resolution against a Blob URL does not work —
   * ending with `/`, containing only characters that survive URI
   * normalisation unescaped, stable for the life of the provider because the
   * registry's keys are built from it, and unique per provider so two
   * tilesets on one globe cannot collide.
   */
  readonly tokenBase: string;
  /** `info.cube` — the octree root every node's cube is stepped from. */
  readonly cube: Bounds;
  /** The key this page is rooted at. `0-0-0-0` for the file's root page. */
  readonly rootKey: NodeKey;
  /** The whole file's root geometric error, from `measureRootGeometricError`. */
  readonly rootGeometricError: number;
  readonly transform: CrsTransform;
}

export interface SyntheticTileset {
  readonly json: TilesetJson;
  /** Keyed by full content URI, which is what the interceptor is handed. */
  readonly entries: ReadonlyMap<string, TileEntry>;
  /**
   * See `TileTree.synthesizedAncestors`: tiles, not files or gaps, and not
   * always ancestors either — an empty page's synthesised, childless root is
   * nobody's ancestor and is still counted here.
   */
  readonly synthesizedAncestors: number;
}

const uriFor = (tokenBase: string, entry: TileEntry): string =>
  `${tokenBase}${entry.kind === 'points' ? 'n' : 'h'}/${keyText(entry.key)}`;

/**
 * Turns one hierarchy page into a tileset and the registry that resolves it.
 *
 * The same function serves the file's root page and every sub-page: Decision
 * 2's second constraint, that a hierarchy tile expands into an external
 * tileset, is met by calling this again rather than by a second code path.
 *
 * Pure and synchronous. Blob URLs, codec installation and the `Resource`
 * interception that consumes these URIs belong to the provider.
 */
export function buildTileset(page: HierarchyPage, context: TilesetContext): SyntheticTileset {
  const tree = buildTileTree(context.url, page, context.rootKey);
  const entries = new Map<string, TileEntry>();

  const tileFor = (node: TileNode, isRoot: boolean): TileJson => {
    const children = node.children.map((child) => tileFor(child, false));

    let content: { readonly uri: string } | undefined;
    if (node.entry !== undefined) {
      const uri = uriFor(context.tokenBase, node.entry);
      entries.set(uri, node.entry);
      content = { uri };
    }

    // Assembled with conditional spreads rather than by assigning `undefined`:
    // `exactOptionalPropertyTypes` distinguishes an absent property from one
    // present and undefined, but a reader downstream cannot — `content` reaches
    // it as JSON, and `JSON.stringify({ a: 1, content: undefined })` drops the
    // key exactly as omitting it would. What actually holds this shape is
    // `tsc`, two ways. `tileFor`'s `: TileJson` return annotation above is
    // load-bearing, not decorative — remove it and the recursive call through
    // `children` makes the function's own return type circular, which `tsc`
    // refuses (TS7023, "implicitly has return type 'any'") rather than
    // silently typing it looser. And with the annotation in place, replacing
    // the conditional spread with a plain `content,` (assigning `undefined`
    // outright) is what `exactOptionalPropertyTypes` itself actually refuses
    // (TS2375) — that error, not TS7023, is the one naming this shape.
    return {
      boundingVolume: { region: regionForKey(context.cube, node.key, context.transform) },
      geometricError: geometricErrorAtDepth(context.rootGeometricError, node.key.depth),
      ...(isRoot ? { refine: 'ADD' as const } : {}),
      ...(content === undefined ? {} : { content }),
      ...(children.length === 0 ? {} : { children }),
    };
  };

  const root = tileFor(tree.root, true);

  return {
    json: { asset: { version: '1.0' }, geometricError: root.geometricError, root },
    entries,
    synthesizedAncestors: tree.synthesizedAncestors,
  };
}
