// Serves the built consumer app and the COPC fixture. Range-only by design:
// Decision 4 forbids a 200 whole-file fallback, so a smoke server that offered
// one would let a regression through unnoticed.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

export function startServer({ root, fixture, port }) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);

    if (path === '/data/one.copc.laz') {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (match === null) {
        res.writeHead(400).end('this server answers ranges only');
        return;
      }
      const start = Number(match[1]);
      if (start >= fixture.length) {
        res.writeHead(416, { 'content-range': `bytes */${fixture.length}` }).end();
        return;
      }
      const end = Math.min(Number(match[2]), fixture.length - 1);
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${fixture.length}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      res.end(Buffer.from(fixture.subarray(start, end + 1)));
      return;
    }

    const file = join(root, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      statSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const [, , root, fixturePath, port] = process.argv;
  await startServer({
    root,
    fixture: new Uint8Array(readFileSync(fixturePath)),
    port: Number(port),
  });
  console.log(`smoke server on ${port}`);
}
