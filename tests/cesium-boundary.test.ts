import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importClosure, srcRelative } from './import-closure.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (extname(full) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Whether `source` names a Cesium package as an import specifier: `cesium`,
 * a path inside it, or any `@cesium/*` package (`engine`, `widgets`, and
 * `core`, which 1.146 split out of the engine) — a static `import ... from '...'`, a bare `import '...'`, or a
 * literal dynamic `import('...')`. Deliberately not `importClosure`'s own
 * `findSpecifiers`: that walker only ever records *relative* specifiers
 * (`content.startsWith('.')`, `tests/import-closure.ts`), so a bare package
 * name like `cesium` never reaches its result — checking for one needs a
 * different, narrower scan, not a broader use of the same one.
 *
 * A cheap, pattern-based check, not a full lexer: it does not skip comments
 * or strings the way `findSpecifiers` does. That is safe here specifically
 * because the two real comment mentions of `@cesium/engine` in `src/`
 * outside this module today (`src/worker/pnts.ts`) both write it inside
 * backtick-quoted prose (`` `@cesium/engine` ``), never as
 * `from '@cesium/engine'` or `import '@cesium/engine'` — the shapes below
 * require a straight quote immediately after `from`/`import`, which prose
 * never produces.
 */
function importsCesium(source: string): boolean {
  const specifier = "(['\"])(cesium(?:/[^'\"]*)?|@cesium/[^'\"]+)\\1";
  return (
    new RegExp(`\\bfrom\\s*${specifier}`).test(source) ||
    new RegExp(`^\\s*import\\s*${specifier}`, 'm').test(source) ||
    new RegExp(`\\bimport\\s*\\(\\s*${specifier}\\s*\\)`).test(source)
  );
}

describe('importsCesium', () => {
  // Cesium 1.146 split its math and utility classes into @cesium/core, so a
  // check that names only @cesium/engine would let that package through.
  it.each([
    "import { Cartesian3 } from 'cesium';",
    "import { Cartesian3 } from '@cesium/engine';",
    "import { Cartesian3 } from '@cesium/core';",
    "import { Viewer } from '@cesium/widgets';",
    "import Cartesian3 from 'cesium/Source/Core/Cartesian3.js';",
    "import '@cesium/core';",
    "const core = await import('@cesium/core');",
  ])('catches %s', (source) => {
    expect(importsCesium(source)).toBe(true);
  });

  it.each([
    "import { thing } from 'cesium-like';",
    "import { thing } from '@cesiumjs/other';",
    '// re-exported from `@cesium/core` by cesium',
  ])('leaves %s alone', (source) => {
    expect(importsCesium(source)).toBe(false);
  });
});

describe('what src/index.ts can reach', () => {
  const reachable = importClosure('index.ts');

  // Without this, the isolation check below could pass on a closure that
  // never reached Cesium's own boundary in the first place — a mistyped
  // entry point, or a barrel that stopped re-exporting the provider, would
  // leave nothing under src/cesium-runtime/ in scope for that check to find.
  it('reaches the provider and the Worker pool', () => {
    expect(reachable).toContain('cesium-runtime/provider.ts');
    expect(reachable).toContain('worker/pool.ts');
  });
});

// Decision 2's isolation rule, enforced rather than documented: every
// internal Cesium access (`_runtimeContentCodec`, underscore fields,
// undeclared runtime exports) stays inside src/cesium-runtime/, so a static
// check on the specifier alone — not on which fields it touches — is enough
// to catch a violation.
describe('nothing outside src/cesium-runtime/ imports cesium', () => {
  const files = listTsFiles(SRC).filter(
    (file) => !srcRelative(file).startsWith(`cesium-runtime${'/'}`),
  );

  it('checked at least one file outside cesium-runtime', () => {
    // Guards against a broken path silently checking nothing, the same way
    // tests/import-closure.test.ts's own tree walk does.
    expect(files.length).toBeGreaterThan(0);
  });

  it('names no Cesium package as an import specifier', () => {
    const offenders = files
      .map(srcRelative)
      .filter((file) => importsCesium(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
