import { describe, expect, it } from 'vitest';
import { importClosure } from './import-closure.js';

describe('what a Worker can reach through crs/worker.ts', () => {
  const reachable = importClosure('crs/worker.ts');

  // Without this the three exclusions below would pass on an empty result —
  // a mistyped entry, a changed extension, a regex that stops matching.
  it('reaches the transform and the ECEF conversion', () => {
    expect(reachable).toContain('crs/transform.ts');
    expect(reachable).toContain('crs/ecef.ts');
  });

  it('cannot reach the registry, the lookup, or the main-thread barrel', () => {
    expect(reachable).not.toContain('crs/registry.ts');
    expect(reachable).not.toContain('crs/resolve.ts');
    expect(reachable).not.toContain('crs/index.ts');
  });
});
