/**
 * The entry point that keeps the registry out of a Worker's reach — a
 * statement about what this barrel carries, not about where the builder runs.
 *
 * Decision 3 runs the transform in a Worker, where module state is a fresh
 * copy: a registry consulted there holds only the default EPSG:4326 however
 * much the caller registered, and `resolveCrsDefinition` would reject every
 * real file. Keeping those out of reach is a job for the entry point rather
 * than for a rule — a Worker importing this barrel cannot reach them, and
 * `tests/crs-worker-boundary.test.ts` walks what it can reach to keep that so.
 *
 * `createTransformFromDefinition` itself is realm-free, and main-thread
 * callers import it from here too: `buildTileset` and
 * `measureRootGeometricError` each need a `CrsTransform`, and both run at
 * `fromUrl` time, before any Worker exists.
 */
export type { CrsTransform } from './transform.js';
export { createTransformFromDefinition } from './transform.js';
