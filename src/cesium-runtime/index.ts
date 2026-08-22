/**
 * The cesium-runtime module's public surface: `COPCTilesetProvider` and the
 * option/stats types a caller needs to construct or read one.
 *
 * `ScheduledRangeResource`, `createCodec`, and `DELEGATED_PRIMITIVE_METHODS`
 * stay out of this barrel. The first two are reached only through
 * `COPCTilesetProvider.fromUrl` — nothing outside this module constructs one
 * directly. `DELEGATED_PRIMITIVE_METHODS` is `provider.ts`'s own list of the
 * `PrimitiveCollection` method names it delegates to `tileset`, exported
 * `@internal` only so `tests/cesium-provider-lifetime.test.ts` can compare it
 * against Cesium's source; it changes with every Cesium upgrade, and putting
 * it in the package entry would put that churn into the semver surface.
 */
export type { COPCTilesetProviderOptions, ProviderStats } from './provider.js';
export { COPCTilesetProvider } from './provider.js';
