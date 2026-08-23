import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  name: string;
  license: string;
  type: string;
  exports: unknown;
  types: unknown;
  files: unknown;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

// The manifest is a contract rather than a preference: OVERVIEW §5 fixes both
// the dependency set and the Cesium range, and Decision 2 explains why that
// range is narrow. A dependency added without updating OVERVIEW fails here.
describe('package manifest', () => {
  it('publishes MIT-licensed browser ESM under the agreed name', () => {
    expect(manifest.name).toBe('copc-tileset-provider');
    expect(manifest.license).toBe('MIT');
    expect(manifest.type).toBe('module');
  });

  it('accepts only the Cesium versions Decision 2 was verified against', () => {
    expect(manifest.peerDependencies).toEqual({ cesium: '>=1.142.0 <1.145.0' });
  });

  it('declares no runtime dependency beyond the three OVERVIEW §5 names', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['copc', 'laz-perf', 'proj4']);
  });

  it('resolves the package name to the two entry points a caller needs', () => {
    // Two paths, not one. The root re-exports `COPCTilesetProvider`, which
    // statically imports `cesium` — so a Worker importing it dies, measured
    // (`docs/gate-render-findings.md`). `./worker` is the Worker realm's own
    // entry, free of Cesium by a check in `tests/worker-boundary.test.ts`.
    // Both point at build output: changing either changes what a consumer can
    // import, so it is pinned here rather than noticed at publish time.
    expect(manifest.exports).toEqual({
      '.': { types: './dist/types/index.d.ts', import: './dist/index.js' },
      './worker': { types: './dist/types/worker/browser.d.ts', import: './dist/worker.js' },
      './package.json': './package.json',
    });
    expect(manifest.types).toBe('./dist/types/index.d.ts');
  });

  it('ships only the build output', () => {
    // Without `files`, `npm pack` falls back to everything not ignored, which
    // would put `docs/superpowers/` — plans, specs, this project's internal
    // notes — in front of every consumer.
    expect(manifest.files).toEqual(['dist']);
  });

});
