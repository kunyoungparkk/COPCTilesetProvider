import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderNotices } from '../build/third-party-notices.mjs';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  name: string;
  version: string;
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
    // (`docs/cesium-runtime-gate.md`). `./worker` is the Worker realm's own
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
    // would put this project's internal notes in front of every consumer. The
    // third-party notices ride along inside `dist/`, written there by the
    // build, so this list stays one entry.
    expect(manifest.files).toEqual(['dist']);
  });

  it('carries third-party notices that match the installed dependencies', () => {
    // The bundles inline copc, laz-perf and proj4, and minification strips the
    // license headers that would have travelled with their code — so this file
    // is the only thing discharging MIT's "include the notice" and Apache's
    // "include the license". It is generated, so the failure this catches is a
    // dependency bumped without `npm run notices`.
    expect(read('../THIRD-PARTY-NOTICES.md')).toBe(renderNotices());
  });

  it('pins the demo to the version this manifest publishes', () => {
    // `examples/index.html` loads the *published* package from a CDN, which is
    // deliberate — it is the only place a defect in the distribution shows up
    // in something a person looks at. The cost is that the version is written
    // twice, and a release that bumps one and not the other leaves the demo
    // silently running old code, dropping options the new version added.
    // Measured: that is exactly what happened between 0.1.1 and 0.2.0.
    expect(read('../examples/index.html')).toContain(
      `copc-tileset-provider@${manifest.version}?external=cesium`,
    );
  });
});
