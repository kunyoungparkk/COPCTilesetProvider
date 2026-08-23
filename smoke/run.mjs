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
const CESIUM = 'cesium@1.143.0';

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const step = (message) => console.log(`\n── ${message}`);

const work = mkdtempSync(join(tmpdir(), 'copc-smoke-'));
console.log(`smoke workspace: ${work}`);

step('npm pack');
const tarball = join(work, run('npm', ['pack', '--pack-destination', work], REPO).trim());
console.log(tarball);

step('what the tarball contains');
const entries = run('tar', ['-tzf', tarball])
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
for (const forbidden of ['docs/', 'src/', 'fixtures/', 'tests/', 'gate/', 'smoke/']) {
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
  execFileSync(
    'npx',
    ['playwright', 'test', '--config', 'smoke/playwright.config.mjs', '--reporter=list'],
    { cwd: REPO, stdio: 'inherit', env: { ...process.env, SMOKE_PORT: String(PORT) } },
  );
} finally {
  server.kill();
}

step('sizes, for the record');
for (const name of ['index.js', 'worker.js']) {
  const path = join(app, 'node_modules', 'copc-tileset-provider', 'dist', name);
  console.log(`  dist/${name}  ${readFileSync(path).length} bytes`);
}
console.log('\nsmoke passed: the packed tarball renders.');
