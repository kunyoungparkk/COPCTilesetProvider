import { describe, expect, it } from 'vitest';
import { importClosure } from './import-closure.js';

describe('what a Worker can reach through worker/pipeline.ts', () => {
  const reachable = importClosure('worker/pipeline.ts');

  // Without this the two exclusions below would pass on an empty result —
  // a mistyped entry, a changed extension, a regex that stops matching. Also
  // pins that the pipeline actually composes the three units it claims to.
  it('reaches the transform, the ECEF conversion, and the three units it composes', () => {
    expect(reachable).toContain('crs/transform.ts');
    expect(reachable).toContain('crs/ecef.ts');
    expect(reachable).toContain('worker/decode.ts');
    expect(reachable).toContain('worker/positions.ts');
    expect(reachable).toContain('worker/pnts.ts');
  });

  it('cannot reach the registry, the resolver, or the main-thread barrel', () => {
    expect(reachable).not.toContain('crs/registry.ts');
    expect(reachable).not.toContain('crs/resolve.ts');
    expect(reachable).not.toContain('crs/index.ts');
  });
});

// The barrel is what anything outside this module imports, so the guarantee
// has to hold for it and not only for the file it re-exports. Its closure is
// pipeline.ts's plus itself today; asserting it separately is what keeps that
// true when the barrel grows an export.
describe('what a Worker can reach through the worker barrel', () => {
  const reachable = importClosure('worker/index.ts');

  it('reaches the pipeline and the units behind it', () => {
    expect(reachable).toContain('worker/pipeline.ts');
    expect(reachable).toContain('worker/decode.ts');
    expect(reachable).toContain('crs/transform.ts');
  });

  it('cannot reach the registry, the resolver, or the main-thread barrel', () => {
    expect(reachable).not.toContain('crs/registry.ts');
    expect(reachable).not.toContain('crs/resolve.ts');
    expect(reachable).not.toContain('crs/index.ts');
  });
});
