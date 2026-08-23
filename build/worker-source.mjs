// Injects the built Worker's text into the library bundle, so `fromUrl` can
// make a Blob URL Worker without the consumer's bundler having to understand
// any worker convention (spec §4).
import { readFileSync } from 'node:fs';

const SPECIFIER = 'virtual:worker-source';
const RESOLVED = '\0virtual:worker-source';

/** `file` is the built Worker; pass undefined to stub the module out. */
export function workerSource(file) {
  return {
    name: 'worker-source',
    resolveId(id) {
      return id === SPECIFIER ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      if (file === undefined) return 'export default undefined;';
      // Read at load time, not at config time: the Worker config runs first
      // and this file does not exist until it has.
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}
