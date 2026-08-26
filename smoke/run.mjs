// The publish smoke: pack, install into a project that knows nothing about
// this repository, build it with a real bundler, and render it.
//
// OVERVIEW §5 calls for this once before publish, and it is the only place a
// defect that lives only in the distribution — a missing Worker bundle, a wasm
// that never shipped, an `exports` map that names a path `npm pack` left out —
// can show itself. It installs from the network, so it is not CI's (CLAUDE.md
// keeps CI offline); run it by hand with `npm run smoke`.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBundles } from '../build/assert-bundles.mjs';
import { buildFixture } from './fixture.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.SMOKE_PORT ?? 8933);
// Which Cesium the consumer project installs. Overridable so the smoke can
// verify both ends of the supported peer range, which is the only way an
// expanded range means anything: `SMOKE_CESIUM=1.142.0 npm run smoke`.
const CESIUM = `cesium@${process.env.SMOKE_CESIUM ?? '1.144.0'}`;

// `npm` and `npx` are `.cmd` shims on Windows: `execFileSync` cannot find
// either by bare name, and Node refuses to spawn a `.cmd` at all without a
// shell. Nothing else here needs this — `tar` is a real executable on Windows
// 10 and later, and the server below is spawned as `process.execPath`.
const SHELL_ONLY_ON_WINDOWS = new Set(['npm', 'npx']);

// A shell means the arguments stop being a list: Node joins them with spaces
// and quotes nothing, so an argument containing one is read as two. That is
// not hypothetical here — every path passed below descends from `tmpdir()`,
// which on Windows sits under the user's name.
const quoteForShell = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/**
 * The `execFileSync` arguments for one command, adjusted for the shims above.
 * Shared rather than folded into `run`, because the Playwright call below
 * needs its own stdio and environment and so cannot go through it.
 */
const shimmed = (cmd, args) => {
  const shell = process.platform === 'win32' && SHELL_ONLY_ON_WINDOWS.has(cmd);
  return { args: shell ? args.map(quoteForShell) : args, shell };
};

const run = (cmd, args, cwd) => {
  const { args: spawnArgs, shell } = shimmed(cmd, args);
  return execFileSync(cmd, spawnArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...(shell && { shell: true }),
  });
};

const step = (message) => console.log(`\n── ${message}`);

const work = mkdtempSync(join(tmpdir(), 'copc-smoke-'));
console.log(`smoke workspace: ${work}`);

step('npm pack');
const tarballName = run('npm', ['pack', '--pack-destination', work], REPO).trim();
const tarball = join(work, tarballName);
console.log(tarball);

step('what the tarball contains');
// Named relative to `work` rather than absolutely, because GNU tar reads the
// colon in `C:\...` as a host separator and tries to reach a machine called
// `C` — and `--force-local`, which would tell it otherwise, is a GNU option
// that the bsdtar on macOS does not have. A path with no colon needs neither.
const entries = run('tar', ['-tzf', tarballName], work)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const ALLOWED_TOP = new Set(['package/package.json', 'package/README.md', 'package/LICENSE']);
for (const entry of entries) {
  if (ALLOWED_TOP.has(entry)) continue;
  if (entry.startsWith('package/dist/')) continue;
  throw new Error(`tarball ships something outside dist/: ${entry}`);
}
// Named separately from the loop above, because "nothing outside dist/" would
// also be satisfied by a tarball that shipped nothing at all.
for (const forbidden of ['src/', 'fixtures/', 'tests/', 'smoke/']) {
  const leaked = entries.find((entry) => entry.includes(`/${forbidden}`));
  if (leaked !== undefined) throw new Error(`tarball ships ${forbidden}: ${leaked}`);
}
if (!entries.includes('package/dist/index.js') || !entries.includes('package/dist/worker.js')) {
  throw new Error('tarball is missing one of the two bundles');
}
console.log(`${entries.length} entries, all under dist/`);

step(`npm install <tarball> ${CESIUM} vite`);
const app = join(work, 'app');
run('mkdir', ['-p', app]);
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: 'copc-smoke-consumer', private: true, type: 'module' }, null, 2),
);
run('npm', ['install', tarball, CESIUM, 'vite@8', '--no-audit', '--no-fund'], app);

step('the installed bundles, on their own terms');
assertBundles(join(app, 'node_modules', 'copc-tileset-provider', 'dist'));
console.log('bundle assertions passed against the installed package');

step('vite build');
cpSync(join(REPO, 'smoke', 'app'), app, { recursive: true });
writeFileSync(
  join(app, 'vite.config.mjs'),
  `import { cpSync } from 'node:fs';
import { defineConfig } from 'vite';
// Cesium's prebuilt assets, which CESIUM_BASE_URL points at.
export default defineConfig({
  plugins: [{
    name: 'cesium-assets',
    closeBundle() {
      cpSync('node_modules/cesium/Build/CesiumUnminified', 'dist/cesium', { recursive: true });
    },
  }],
});
`,
);
run('npx', ['vite', 'build'], app);

step('render it');
const built = join(app, 'dist');
writeFileSync(join(work, 'one.copc.laz'), Buffer.from(buildFixture()));

// The server runs in its own process on purpose: `execFileSync` below blocks
// this one's event loop for as long as Playwright runs, so a server sharing it
// could not answer a single request. Measured the hard way — the first version
// of this script hung here with both tests waiting on a page that never
// loaded.
const server = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./server.mjs', import.meta.url)),
    built,
    join(work, 'one.copc.laz'),
    String(PORT),
  ],
  { stdio: 'inherit' },
);
try {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const playwright = shimmed('npx', [
    'playwright',
    'test',
    '--config',
    'smoke/playwright.config.mjs',
    '--reporter=list',
  ]);
  execFileSync('npx', playwright.args, {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, SMOKE_PORT: String(PORT) },
    ...(playwright.shell && { shell: true }),
  });
} finally {
  server.kill();
}

step('sizes, for the record');
for (const name of ['index.js', 'worker.js']) {
  const path = join(app, 'node_modules', 'copc-tileset-provider', 'dist', name);
  console.log(`  dist/${name}  ${readFileSync(path).length} bytes`);
}
console.log('\nsmoke passed: the packed tarball renders.');
