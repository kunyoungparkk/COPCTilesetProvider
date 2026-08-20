/**
 * The main thread's half of the module.
 *
 * `createTransformFromDefinition` is deliberately absent: it belongs to the
 * Worker, and this barrel would drag the registry across with it. `worker.ts`
 * is the entry point for that side.
 */
export { geodeticToEcef } from './ecef.js';
export { findHorizontalEpsgCode } from './horizontal-code.js';
export { registerCrs } from './registry.js';
export { resolveCrsDefinition } from './resolve.js';
export type { CrsTransform } from './transform.js';
