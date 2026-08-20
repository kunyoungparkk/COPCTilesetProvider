import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// Static and dynamic alike: a re-export carries a module in just as surely as
// an import does, and `await import()` carries it in at run time. Matching the
// specifier rather than the statement also means a formatter wrapping a long
// import list cannot hide one.
const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** Every module under `src/` that this entry point can reach, itself included. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);

    const source = readFileSync(resolve(SRC, file), 'utf8');
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      // Written as the `.js` the browser will fetch; read as the `.ts` on disk.
      const target = relative(SRC, resolve(dirname(resolve(SRC, file)), specifier ?? ''))
        .replace(/\.js$/, '.ts');
      if (!target.startsWith('..')) {
        queue.push(target);
      }
    }
  }
  return [...seen];
}

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
