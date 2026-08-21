/**
 * The registry's half of the module, and the only main-thread-only half: the
 * registry is module state, so a Worker consulting it would find nothing the
 * caller registered.
 *
 * `createTransformFromDefinition` is absent from here, but not because it
 * belongs to a Worker — it is realm-free, and the main thread builds one at
 * `fromUrl` time for `regionForKey` and `measureRootGeometricError`. It is
 * absent so that `worker.ts` stays the single entry reaching it, which is what
 * makes "the builder drags no registry with it" checkable; import it there.
 */
export { geodeticToEcef } from './ecef.js';
export { findHorizontalEpsgCode } from './horizontal-code.js';
export { registerCrs } from './registry.js';
export { resolveCrsDefinition } from './resolve.js';
export type { CrsTransform } from './transform.js';
