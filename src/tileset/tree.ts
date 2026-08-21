import type { HierarchyPage, NodeKey } from '../copc/index.js';
import { MalformedHierarchyError } from '../errors/index.js';

/** What a tile's content URI stands for. Both shapes are assignable to `ByteRange`. */
export type TileEntry =
  | {
      readonly kind: 'points';
      readonly key: NodeKey;
      readonly offset: number;
      readonly length: number;
      readonly pointCount: number;
    }
  | {
      readonly kind: 'hierarchy';
      readonly key: NodeKey;
      readonly offset: number;
      readonly length: number;
    };

export interface TileNode {
  readonly key: NodeKey;
  /** Absent for a zero-point node and for a synthesised tile — usually an ancestor, but the empty page's synthesised root is not one. */
  readonly entry: TileEntry | undefined;
  /**
   * True when the page named no entry for this key.
   *
   * Usually this means the tile exists only to bridge a gap to a deeper
   * descendant. But an empty page synthesises one such tile with no
   * descendants at all — a childless, contentless root — see the "empty
   * page" test.
   *
   * Nothing in the library reads it: the emitted tile is the same either way.
   * It is here so the tests can tell a synthesised tile from a zero-point one,
   * which `entry === undefined` cannot — it holds for both.
   */
  readonly synthesized: boolean;
  readonly children: readonly TileNode[];
}

export interface TileTree {
  readonly root: TileNode;
  /**
   * The number of tiles this call synthesised.
   *
   * Tiles, not files, and not gaps: one gap spanning several levels produces
   * one tile per level. Equal to the number of nodes with `synthesized` set —
   * usually ancestors bridging a gap (the field's namesake case), but an
   * empty page's synthesised root, which is nobody's ancestor, is counted
   * here too.
   */
  readonly synthesizedAncestors: number;
}

/** An octree key in the `depth-x-y-z` form COPC writes and our URIs carry. */
export function keyText(key: NodeKey): string {
  return `${key.depth}-${key.x}-${key.y}-${key.z}`;
}

const parentOf = (key: NodeKey): NodeKey => ({
  depth: key.depth - 1,
  x: key.x >> 1,
  y: key.y >> 1,
  z: key.z >> 1,
});

/**
 * The bound `claim` places on `key.depth`, refusing at this depth and beyond.
 *
 * `isBeneath` shifts by `levels = key.depth - rootKey.depth`, and JS `>>`
 * masks that shift count to 5 bits, so at `levels === 32` it stops meaning
 * what it says — in both directions (measured: `1 >> 32` is `1`, not `0`).
 * Bounding `key.depth` bounds `levels` too, but that step relies on a
 * precondition this function does not check: `rootKey.depth >= 0`. Every
 * `NodeKey.depth` `parseKey` produces is non-negative (its regex admits no
 * sign), so every `rootKey` this library builds satisfies it — but nothing
 * stops a caller from passing a negative one directly, and `levels` would
 * then exceed `key.depth` and could still wrap. No COPC octree reaches
 * depth 32 regardless — a real cloud would need 2^32 cells on a side to
 * have a node this deep — so refusing here before `isBeneath` ever runs
 * costs nothing.
 */
const MAX_DEPTH = 32;

/** Whether `key` is `rootKey` or sits beneath it. */
function isBeneath(key: NodeKey, rootKey: NodeKey): boolean {
  if (key.depth < rootKey.depth) {
    return false;
  }
  const levels = key.depth - rootKey.depth;
  return (
    key.x >> levels === rootKey.x && key.y >> levels === rootKey.y && key.z >> levels === rootKey.z
  );
}

// Siblings in one `children` array always share a depth (they are the
// entries `ensure` pushed under the same parent), so the leading term a
// depth-first sort would need is unreachable here; only x, y, z ever decide.
const byKey = (a: TileNode, b: TileNode): number =>
  a.key.x - b.key.x || a.key.y - b.key.y || a.key.z - b.key.z;

interface MutableTileNode {
  readonly key: NodeKey;
  readonly entry: TileEntry | undefined;
  readonly synthesized: boolean;
  readonly children: MutableTileNode[];
}

/**
 * Arranges a page's entries into the tile tree the tileset is emitted from.
 *
 * The boundary Decision 6 draws, and the reason this function throws in some
 * places and repairs in others: **a format violation is still a
 * `MalformedHierarchyError`; synthesis applies only to a valid but incomplete
 * tree.** A key that is both a node and a page pointer, and an entry from
 * outside this page's subtree, are violations — the first has two entries
 * disagreeing about where data lives, the second would place a node under an
 * ancestor that is not its own. A missing ancestor is neither: nothing in the
 * specification requires every ancestor to carry an entry, and a key alone
 * determines its cube, so the tile is rebuilt exactly rather than guessed at.
 *
 * Children are sorted so that the emitted JSON does not depend on the order
 * the file happened to list entries in.
 */
export function buildTileTree(url: string, page: HierarchyPage, rootKey: NodeKey): TileTree {
  const rootText = keyText(rootKey);
  // Keyed by text and carrying the parsed `key` back out, rather than a bare
  // `TileEntry | undefined`, so building the tree below never has to re-parse
  // a key out of its own text form.
  const entries = new Map<string, { key: NodeKey; entry: TileEntry | undefined }>();

  const claim = (key: NodeKey, entry: TileEntry | undefined): void => {
    const text = keyText(key);
    if (key.depth >= MAX_DEPTH) {
      throw new MalformedHierarchyError(
        url,
        `its entry ${JSON.stringify(text)} declares depth ${key.depth}, deeper than any COPC octree reaches`,
      );
    }
    if (!isBeneath(key, rootKey)) {
      throw new MalformedHierarchyError(
        url,
        `its entry ${JSON.stringify(text)} is not inside the page rooted at ${JSON.stringify(rootText)}`,
      );
    }
    if (entries.has(text)) {
      throw new MalformedHierarchyError(
        url,
        `its entry ${JSON.stringify(text)} is both a node and a hierarchy page`,
      );
    }
    entries.set(text, { key, entry });
  };

  for (const node of page.nodes) {
    // Decision 6: a zero-point node keeps its tile and loses its content. The
    // specification gives it offset 0 and byteSize 0, so there is nothing to
    // register even if we wanted to.
    claim(
      node.key,
      node.pointCount === 0
        ? undefined
        : {
            kind: 'points',
            key: node.key,
            offset: node.offset,
            length: node.length,
            pointCount: node.pointCount,
          },
    );
  }
  for (const sub of page.pages) {
    claim(sub.key, { kind: 'hierarchy', key: sub.key, offset: sub.offset, length: sub.length });
  }

  const nodes = new Map<string, MutableTileNode>();
  let synthesizedAncestors = 0;

  const ensure = (key: NodeKey): MutableTileNode => {
    const text = keyText(key);
    const existing = nodes.get(text);
    if (existing !== undefined) {
      return existing;
    }

    const claimed = entries.get(text);
    const created: MutableTileNode = {
      key,
      entry: claimed?.entry,
      synthesized: claimed === undefined,
      children: [],
    };
    if (claimed === undefined) {
      synthesizedAncestors += 1;
    }
    nodes.set(text, created);

    if (text !== rootText) {
      ensure(parentOf(key)).children.push(created);
    }
    return created;
  };

  const root = ensure(rootKey);
  for (const claimed of entries.values()) {
    ensure(claimed.key);
  }

  for (const node of nodes.values()) {
    node.children.sort(byKey);
  }

  return { root, synthesizedAncestors };
}
