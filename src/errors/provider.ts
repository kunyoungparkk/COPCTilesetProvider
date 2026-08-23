import { CopcTilesetError } from './base.js';

/**
 * `TilesetContext.tokenBase` failed the one contract check nothing else in
 * the library performs.
 *
 * The provider is `tokenBase`'s only caller — it generates the value and is
 * the one place positioned to check it — so an invalid one reaching here is
 * this library's own bug, not a caller's. It still throws a typed error
 * rather than an assertion failure, because Decision 6 treats every thrown
 * error as part of the API a catch block can branch on.
 */
export class InvalidTokenBaseError extends CopcTilesetError {
  readonly code = 'invalid-token-base';
  readonly tokenBase: string;

  constructor(tokenBase: string, reason: string) {
    super(`tokenBase ${JSON.stringify(tokenBase)} is invalid: ${reason}.`);
    this.tokenBase = tokenBase;
  }
}

/**
 * `COPCTilesetProvider.fromUrl` was given a URL that is not absolute.
 *
 * Every read is an HTTP Range request against an origin (Decision 4), and the
 * per-origin request budget keys on that origin, so there is nothing for a
 * relative URL to be resolved against here. Refused at `fromUrl`'s entry
 * rather than where the origin is first needed: that moment is after the
 * three bootstrap reads have already succeeded, and the failure there is a
 * bare `TypeError: Invalid URL` — no file named, and in a browser no `code`
 * to branch on, against Decision 6's rule that errors are part of the API.
 */
export class InvalidSourceUrlError extends CopcTilesetError {
  readonly code = 'invalid-source-url';
  readonly url: string;

  constructor(url: string) {
    super(
      `${JSON.stringify(url)} is not an absolute URL. This library addresses every ` +
        'read by origin and byte range, so it cannot resolve a relative one on its ' +
        'own. Resolve it against the page first, then pass the result:\n\n' +
        `    COPCTilesetProvider.fromUrl(new URL(${JSON.stringify(url)}, location.href).href, options)`,
    );
    this.url = url;
  }
}

/**
 * `fromUrl` was called without `spawnWorker` by a build that has no Worker
 * bundled into it — which means a source checkout, since the published package
 * always carries one (`rolldown.config.mjs`).
 */
export class WorkerBundleMissingError extends CopcTilesetError {
  readonly code = 'worker-bundle-missing';

  constructor() {
    super(
      'This build has no Worker bundled into it, so `fromUrl` cannot make one ' +
        'for you.\n\n' +
        'Either run `npm run build` and load the library from `dist/`, or pass ' +
        'your own:\n\n' +
        "    import { browserPort } from 'copc-tileset-provider';\n" +
        "    COPCTilesetProvider.fromUrl(url, {\n" +
        "      spawnWorker: () => browserPort(new Worker(yourWorkerUrl, { type: 'module' })),\n" +
        '    });\n\n' +
        'The published package always carries a Worker, so a consumer never ' +
        'reaches this.',
    );
  }
}
