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
    expect(manifest.peerDependencies).toEqual({ cesium: '>=1.142.0 <1.144.0' });
  });

  it('declares no runtime dependency beyond the three OVERVIEW §5 names', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['copc', 'laz-perf', 'proj4']);
  });

  it('resolves the package name to the one entry point, and nothing else', () => {
    // A single string rather than a map, so `exports` is the whole reachable
    // surface: there is no deep import, and anything a caller must name has
    // to be re-exported from this file. `src/index.ts` rather than a build
    // output because no build exists yet — OVERVIEW §5 lists `npm run build`
    // among the scripts deliberately absent until the tooling behind them
    // does. Changing either value changes what a consumer can import, so it
    // is pinned here rather than left to be noticed at publish time.
    expect(manifest.exports).toBe('./src/index.ts');
    expect(manifest.types).toBe('./src/index.ts');
  });
});
