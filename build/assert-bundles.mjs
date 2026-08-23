// What the bundles must be true of, in a form both the build and the publish
// smoke can run. Each assertion exists because something specific would
// otherwise regress silently.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
}

// Run directly (`node build/assert-bundles.mjs dist`) as the build's last step.
if (process.argv[1]?.endsWith('assert-bundles.mjs')) {
  assertBundles(process.argv[2] ?? 'dist');
  console.log('bundle assertions passed');
}
