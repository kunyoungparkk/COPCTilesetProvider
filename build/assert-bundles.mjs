// What the bundles must be true of, in a form both the build and the publish
// smoke can run. Each assertion exists because something specific would
// otherwise regress silently.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The wasm is 214,351 bytes and base64 grows it by a third, so a Worker bundle
// that lost it would fall far below this. Deliberately loose: this catches
// "the wasm is gone", not "the wasm changed size".
const WORKER_MIN_BYTES = 300_000;

export function assertBundles(distDir) {
  const worker = readFileSync(join(distDir, 'worker.js'), 'utf8');
  const index = readFileSync(join(distDir, 'index.js'), 'utf8');

  // Decision 2: Cesium is a peer dependency and the Worker realm has no
  // business touching it. The render gate measured what happens when it does
  // — the Worker dies before handling a message.
  for (const marker of ['from "cesium"', "from 'cesium'", 'Cesium3DTileset']) {
    if (worker.includes(marker)) {
      throw new Error(`dist/worker.js reaches Cesium (found ${marker})`);
    }
  }

  // Node-only built-ins in a browser bundle mean laz-perf's Node build got in.
  for (const marker of ['require("fs")', "require('fs')", '__dirname']) {
    if (index.includes(marker)) {
      throw new Error(`dist/index.js carries a Node-only reference (${marker})`);
    }
  }

  if (statSync(join(distDir, 'worker.js')).size < WORKER_MIN_BYTES) {
    throw new Error('dist/worker.js is too small to contain the inlined wasm');
  }

  // The library has to carry the Worker's text, or `fromUrl` has nothing to
  // make a Blob from and every consumer is back to writing `spawnWorker`.
  if (!index.includes('self.onmessage') && !index.includes('onmessage=')) {
    throw new Error('dist/index.js does not contain the inlined Worker source');
  }

  // Both bundles inline their dependencies, and minification strips the
  // license headers that would otherwise have travelled with that code — so
  // the notices file is the only thing carrying it. Read the names from the
  // manifest rather than listing them here: a dependency added without a
  // notice is exactly what this catches.
  const noticesPath = join(distDir, 'THIRD-PARTY-NOTICES.md');
  if (!existsSync(noticesPath)) {
    throw new Error(`${noticesPath} is missing; the bundles ship other people's code`);
  }
  const notices = readFileSync(noticesPath, 'utf8');
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  for (const name of Object.keys(manifest.dependencies)) {
    if (!notices.includes(`## ${name} `)) {
      throw new Error(`THIRD-PARTY-NOTICES.md does not cover the bundled ${name}`);
    }
  }
}

// Run directly (`node build/assert-bundles.mjs dist`) as the build's last step.
if (process.argv[1]?.endsWith('assert-bundles.mjs')) {
  assertBundles(process.argv[2] ?? 'dist');
  console.log('bundle assertions passed');
}
