# Changelog

Notable changes to `copc-tileset-provider`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
caveat that `0.x` minors may carry behaviour changes, as 0.2.0 does.

## [Unreleased]

### Added

- `THIRD-PARTY-NOTICES.md`, shipped inside `dist/`. The bundles inline copc,
  laz-perf and proj4, and minification strips the license headers that would
  otherwise have travelled with their code — the published 0.1.x and 0.2.0
  tarballs carried none. Generated from the installed packages by
  `npm run notices`, and asserted current by `tests/manifest.test.ts`.
- A release workflow: pushing a `v*` tag builds, publishes with npm provenance,
  and opens a GitHub Release.

## [0.2.0] — 2026-08-25

### Added

- `geoidHeight` option on `fromUrl`. A file storing orthometric heights — most
  surveyed LiDAR — lands at the geoid's separation from the ellipsoid unless
  it is corrected; the pinned Autzen file is 23.3 m out. The option is that
  separation in metres, added after the file's linear-unit scaling, and it
  reaches the tile points, the bounding volumes and the root geometric error
  through the one transform both realms build.
- `CrsGeoidHeightNotFiniteError`. A `NaN` or a string reaching `geoidHeight`
  previously produced `NaN` coordinates and `null` entries in the synthetic
  tileset, without throwing.

### Changed

- **Behaviour:** a file that declares a vertical CRS and is opened without a
  `geoidHeight` now logs a console warning naming the code found, the dataset's
  centre, and the call to paste. It loads as before. Every user of
  geoid-referenced data will see this; pass `geoidHeight: 0` to silence it for
  a file whose heights are already ellipsoidal.
- OVERVIEW §6 narrows its geoid non-goal to *automation*: a caller-supplied
  constant is supported, reading a geoid grid or calling a lookup service is
  still out of scope. proj4js 2.21 carries no vertical grid support (measured),
  so proj4 cannot do this on the library's behalf.

## [0.1.1] — 2026-08-24

### Added

- Cesium 1.144 support. The peer range is `>=1.142.0 <1.145.0`, and both ends
  are verified by render rather than by reasoning
  (`src/cesium-runtime/gate-findings.md`). The floor is measurement, not choice: 1.141
  has no `_runtimeContentCodec` slot, so Decision 2's mechanism does not exist
  there.

## [0.1.0] — 2026-08-23

First published release. `COPCTilesetProvider.fromUrl(url)` streams a static
COPC file into CesiumJS with no pre-tiling step: verified HTTP Range reads,
LAZ decode and coordinate transform in a Worker pool, and a synthetic 3D Tiles
document that hands traversal, caching, styling and picking to Cesium itself.

[Unreleased]: https://github.com/kunyoungparkk/COPCTilesetProvider/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kunyoungparkk/COPCTilesetProvider/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kunyoungparkk/COPCTilesetProvider/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kunyoungparkk/COPCTilesetProvider/releases/tag/v0.1.0
