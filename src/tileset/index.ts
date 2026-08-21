/**
 * The module's public surface: `buildTileset` and the types a caller names
 * when it constructs a `TilesetContext` or reads the `SyntheticTileset` back.
 *
 * `geometricErrorAtDepth`, `regionForKey`, `buildTileTree` and `keyText` are
 * deliberately absent: nothing outside this module computes a tile's error,
 * bounds a key, arranges a page, or renders a key back to text —
 * `buildTileset` does all four internally and hands back only the finished
 * document and its registry. `TileNode` and `TileTree`, `buildTileTree`'s own
 * return shape, are absent for the same reason: no exported value is ever
 * typed as one.
 */
export type { SyntheticTileset, TileJson, TilesetContext, TilesetJson } from './build.js';
export { buildTileset } from './build.js';
export { measureRootGeometricError } from './geometric-error.js';
export type { Region } from './region.js';
export type { TileEntry } from './tree.js';
