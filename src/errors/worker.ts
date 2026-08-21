import { CopcTilesetError } from './base.js';

/**
 * A chunk decoded to zero points.
 *
 * Decision 6's empty-node invariant means this should be unreachable: the
 * synthetic tileset omits a content descriptor for every `pointCount === 0`
 * hierarchy entry (`src/tileset/tree.ts`), so no chunk for an empty node
 * should ever reach the Worker pipeline in the first place. A zero-point PNTS
 * cannot be served by any path regardless — such a tile never reaches ready,
 * so Cesium's `tilesLoaded` would wait on it forever — so reaching this error
 * means that invariant broke somewhere upstream.
 *
 * `src/worker/pipeline.ts`'s own comment explains why the message below
 * cannot say *where* upstream: `decodeChunk` decodes exactly the count it is
 * asked for and has no independent count to check it against, so a
 * zero-point view is indistinguishable here from this library asking for
 * zero points on its own — both look identical from this layer.
 */
export class ZeroPointChunkError extends CopcTilesetError {
  readonly code = 'zero-point-chunk';

  constructor() {
    super(
      'This chunk decoded to zero points. Decision 6 forbids serving a zero-point ' +
        'PNTS tile by any path, and a pointCount === 0 hierarchy entry should never ' +
        'have reached this pipeline at all — the synthetic tileset omits content for ' +
        'one. This is a defect, either in this library\'s tileset construction or in ' +
        'the file\'s hierarchy page (for example, a pointCount of 0 paired with a ' +
        'nonzero byte length); nothing at this layer can tell which.',
    );
  }
}

/**
 * `placed.positions` does not hold `view.pointCount * 3` components.
 *
 * `encodeNode` (`src/worker/pipeline.ts`) always builds both arguments from
 * the same decoded `view` — `toRelativePositions(view, ...)` — so this is
 * unreachable through the one path this library ships, which is why
 * `encodePnts` stays out of `src/worker/index.ts`'s barrel. The check exists
 * anyway because `encodePnts` is still an exported function a caller (today,
 * only this module's own tests) can call with two values that were never
 * actually paired, and the failure that produces is worse than a throw:
 * measured directly, a `View` reporting 47 points handed a 10-point
 * `RelativePositions` writes a tile where every declared offset is
 * internally consistent — `POINTS_LENGTH`/`BATCH_LENGTH` both 47, header
 * byte-length fields all correct — because every section size is derived
 * from `view.pointCount`, not from how many positions actually exist.
 * Cesium's `PntsParser` reads `POSITION` as `47 * 12 = 564` bytes from a
 * feature-table binary sized for the real 308, straight through `BATCH_ID`
 * and `RGB` and into the batch-table JSON that follows — no throw, no
 * validation failure, just wrong values read from the wrong place.
 */
export class PositionCountMismatchError extends CopcTilesetError {
  readonly code = 'position-count-mismatch';

  constructor(pointCount: number, positionComponents: number) {
    super(
      `encodePnts: view.pointCount is ${pointCount}, so placed.positions should hold ` +
        `${pointCount * 3} components (x, y, z per point), but it holds ` +
        `${positionComponents}. These two must come from the same decoded view — ` +
        'placed must be toRelativePositions(view, transform) for this same view — ' +
        'or the encoded tile is corrupt in a way nothing downstream detects.',
    );
  }
}
