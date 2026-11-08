/**
 * The main-thread half of the module: reading a file's coordinate system out
 * of its WKT. Its failures have to reject `fromUrl`, so it stays where
 * `fromUrl` runs.
 *
 * `createTransformFromDefinition` is absent from here, but not because it
 * belongs to a Worker — it is realm-free, and the main thread builds one at
 * `fromUrl` time for `regionForKey` and `measureRootGeometricError`. It is
 * absent so that `worker.ts` stays the single entry reaching it, which is what
 * makes "the builder drags no resolver with it" checkable; import it there.
 */
export { geodeticToEcef } from './ecef.js';
export { findVerticalEpsgCode } from './epsg-codes.js';
export { resolveCrsDefinition } from './resolve.js';
export type { CrsTransform } from './transform.js';
