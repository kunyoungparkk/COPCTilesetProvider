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

// entry.ts is what a platform bootstrap (tests/worker-entry-node.ts today;
// no browser one exists yet) actually loads into a Worker, so the guarantee
// has to hold at that entry point too, not only at the pipeline barrel it
// wraps — a message handler pulling in either half of the main thread would
// defeat the point of drawing this boundary at all.
describe('what a Worker can reach through worker/entry.ts', () => {
  const reachable = importClosure('worker/entry.ts');

  // Without this the two exclusions below would pass on an empty result —
  // a mistyped entry, a changed extension, a regex that stops matching.
  it('reaches the pipeline, the decoder, and the transform', () => {
    expect(reachable).toContain('worker/pipeline.ts');
    expect(reachable).toContain('worker/decode.ts');
    expect(reachable).toContain('crs/transform.ts');
  });

  it('cannot reach the registry or the main-thread barrel', () => {
    expect(reachable).not.toContain('crs/registry.ts');
    expect(reachable).not.toContain('crs/resolve.ts');
    expect(reachable).not.toContain('crs/index.ts');
  });

  // A Worker that pulled the pool in would carry the main thread's half of
  // the system into every Worker, and nothing else here would notice.
  it('cannot reach the worker pool', () => {
    expect(reachable).not.toContain('worker/pool.ts');
  });
});

// browser.ts is what `dist/worker.js` is built from, so it is the file whose
// closure decides what actually ships into a Worker. The render gate measured
// what a Worker that reaches Cesium does: it dies on "ReferenceError: global
// is not defined" before handling a single message
// (docs/gate-render-findings.md).
describe('what a Worker can reach through worker/browser.ts', () => {
  const reachable = importClosure('worker/browser.ts');

  // Without this the exclusions below would pass on an empty result.
  it('reaches the entry it bootstraps, and through it the pipeline', () => {
    expect(reachable).toContain('worker/entry.ts');
    expect(reachable).toContain('worker/pipeline.ts');
    expect(reachable).toContain('worker/decode.ts');
  });

  it('cannot reach the registry, the resolver, or the main-thread barrel', () => {
    expect(reachable).not.toContain('crs/registry.ts');
    expect(reachable).not.toContain('crs/resolve.ts');
    expect(reachable).not.toContain('crs/index.ts');
  });

  it('cannot reach the worker pool', () => {
    expect(reachable).not.toContain('worker/pool.ts');
  });

  it('cannot reach the library root or anything Cesium-facing', () => {
    expect(reachable).not.toContain('index.ts');
    for (const file of reachable) {
      expect(file).not.toMatch(/^cesium-runtime\//);
    }
  });
});
