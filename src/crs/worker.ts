/**
 * What the Worker half of the module may import.
 *
 * Decision 3 runs the transform in a Worker, where module state is a fresh
 * copy: a registry consulted there holds only the default EPSG:4326 however
 * much the caller registered, and `resolveCrsDefinition` would reject every
 * real file. Keeping those out of reach is a job for the entry point rather
 * than for a rule — a Worker importing this barrel cannot reach them, and
 * `tests/crs-worker-boundary.test.ts` walks what it can reach to keep that so.
 */
export type { CrsTransform } from './transform.js';
export { createTransformFromDefinition } from './transform.js';
