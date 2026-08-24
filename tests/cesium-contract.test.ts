import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Decision 2 rents Cesium's traversal, LoD, request priority, and caching by
// writing to a private slot, `Cesium3DTileset#_runtimeContentCodec`. Private
// means Cesium owes us no stability, so this guard reads the installed engine
// source and fails the moment a fact we build on changes shape. It is offline
// and browser-free by design: a bad `npm update` has to break CI here, not in
// a rendering test nobody runs on every commit.
//
// Each assertion below is a load-bearing dependency, not a description of
// Cesium at large. If one fails, the fix is to re-verify the codec path
// against the new version — never to relax the assertion.

const resolveFrom = createRequire(import.meta.url);

/**
 * Reads a file from Cesium's engine source.
 *
 * `cesium` is a thin re-export of `@cesium/engine`, and its ESM entry points at
 * the engine's readable source rather than a bundle — so this is the code that
 * actually runs in a consuming app, not a build artifact of it.
 */
function engineSource(path: string): string {
  const specifier = `@cesium/engine/Source/${path}`;
  let resolved: string;
  try {
    resolved = resolveFrom.resolve(specifier);
  } catch {
    throw new Error(
      `Cannot resolve ${specifier}. This guard needs Cesium's engine source; ` +
        'run `npm ci` to install the peer dependency before the suite.',
    );
  }
  // Whitespace belongs to Prettier, not to the contract. Collapsing it keeps
  // these assertions from failing the next time Cesium reformats a file.
  return readFileSync(resolved, 'utf8').replace(/\s+/g, ' ');
}

const tile = engineSource('Scene/Cesium3DTile.js');
const tileset = engineSource('Scene/Cesium3DTileset.js');
const resource = engineSource('Core/Resource.js');

// Everything here was read off this version. Pinning it means a failure tells
// you which of the two happened: Cesium moved, or the pin did.
const { version } = resolveFrom('cesium/package.json') as { version: string };

/**
 * Asserts that Cesium still contains a snippet we depend on.
 *
 * Reports a boolean rather than the haystack: normalised, these files are
 * hundreds of kilobytes on a single line, and a diff of that buries the answer.
 * The snippet that went missing is the only thing worth printing.
 */
function expectSnippet(source: string, snippet: string): void {
  expect(source.includes(snippet), `Cesium ${version} no longer contains: ${snippet}`).toBe(true);
}

describe('Cesium runtime content codec contract', () => {
  it('runs against a Cesium version Decision 2 was verified on', () => {
    expect(version).toMatch(/^1\.(142|143|144)\./);
  });

  it('keeps the codec slot we install onto the tileset', () => {
    expectSnippet(tileset, 'this._runtimeContentCodec = undefined;');
  });

  it('hands tile payloads to createContent with the arguments we implement', () => {
    expectSnippet(tile, 'typeof codec.createContent === "function"');
    expectSnippet(tile, 'codec.createContent(tileset, tile, tile._contentResource, arrayBuffer)');
  });

  // The codec branch returns before Cesium sniffs the payload, so Cesium never
  // classifies what we produce. That is what lets us hand back a decoded PNTS
  // content for bytes that arrived as LAZ — and equally why the tile flags in
  // the two assertions below become ours to set.
  it('returns from the codec branch before classifying the payload', () => {
    const dispatch = tile.indexOf('codec.createContent(');
    const classify = tile.indexOf('preprocess3DTileContent(arrayBuffer)');

    expect(dispatch).toBeGreaterThan(-1);
    expect(classify).toBeGreaterThan(dispatch);
    expect(tile.slice(dispatch, classify)).toContain('return content;');
  });

  it('leaves the external-tileset flag to the codec', () => {
    const classify = tile.indexOf('preprocess3DTileContent(arrayBuffer)');

    // Only ever set on the path we skip, so a hierarchy page expanded into an
    // external tileset has to set it itself or Cesium treats it as renderable.
    expect(tile.indexOf('tile.hasTilesetContent = true')).toBeGreaterThan(classify);
  });

  // ScheduledRangeResource (src/cesium-runtime/resource.ts) overrides clone()
  // specifically to survive this branch. Without the override, every derived
  // tile resource downgrades to a plain Resource and copc:// tokens reach the
  // network.
  it('builds a plain Resource on clone() when handed no result, forcing the override', () => {
    expectSnippet(resource, 'Resource.prototype.clone = function (result) { if (!defined(result)) { return new Resource');
  });

  // ScheduledRangeResource's fetchArrayBuffer maps the budget's `deferred`
  // verdict onto exactly this branch by returning undefined: a tile whose
  // fetch returns undefined is not failed, only re-asked next frame.
  it('treats an undefined fetchArrayBuffer result as "ask again next frame", not "failed"', () => {
    expectSnippet(
      tile,
      'const promise = resource.fetchArrayBuffer(); if (!defined(promise)) { ++tileset.statistics.numberOfAttemptedRequests; return; }',
    );
  });

  // ScheduledRangeResource's own doc comment (`src/cesium-runtime/resource.ts`)
  // claims a tile's content resource is always this class because
  // `Cesium3DTileset.fromUrl` routes the base resource it is handed through
  // `Resource.createIfNeeded`, which — for an argument that is already a
  // `Resource` — calls `getDerivedResource` rather than building a plain
  // `Resource` from scratch. That is what lets `clone()`'s override (pinned
  // above) carry the subclass forward from the very first call, not only on
  // tiles derived later. Two snippets, not one spanning both: Cesium's own
  // explanatory comment sits between the `if` and the `return`, and this
  // guard does not depend on that comment's wording.
  it("routes fromUrl's own resource through getDerivedResource, preserving its subclass", () => {
    expectSnippet(resource, 'Resource.createIfNeeded = function (resource) { if (resource instanceof Resource) {');
    expectSnippet(resource, 'return resource.getDerivedResource({ request: resource.request, });');
  });

  it('exposes the content constructors a codec has to return', async () => {
    // `createContent` must resolve to a Cesium3DTileContent, and these two are
    // the ones our tiles need: PNTS for points, external tileset for hierarchy
    // pages. Both are runtime exports of `cesium` — absent from its .d.ts, but
    // reachable without touching anything underscore-prefixed.
    const { Model3DTileContent, Tileset3DTileContent } = (await import('cesium')) as unknown as {
      Model3DTileContent?: { fromPnts?: unknown };
      Tileset3DTileContent?: { fromJson?: unknown };
    };

    expect(Model3DTileContent?.fromPnts).toBeTypeOf('function');
    expect(Tileset3DTileContent?.fromJson).toBeTypeOf('function');
  });
  // Why `resource.ts` aborts a Range read: a rejected request whose
  // `cancelled` flag is set puts the tile back rather than failing it, so a
  // tile the camera moved past is simply asked again later.
  it('treats a cancelled request as try-again, not as a failure', () => {
    expectSnippet(
      tile,
      'if (request.cancelled || request.state === RequestState.CANCELLED) { ' +
        '// Cancelled due to low priority - try again later. ' +
        'tile._contentState = previousState;',
    );
  });

  // Why nothing here aborts a decode. The catch around `makeContent` does not
  // consult `cancelled`, so an aborted decode is a terminal FAILED — worse
  // than the worker slot it would save. If this assertion fails because
  // Cesium added the check, decode cancellation becomes available and this
  // library's own cancellation can be widened to take it.
  it('fails a tile whose content creation throws, cancelled or not', () => {
    const makeContent = tile.indexOf('const content = await makeContent(tile, arrayBuffer);');
    expect(makeContent).toBeGreaterThan(-1);
    const after = tile.slice(makeContent);
    const failed = after.indexOf('tile._contentState = Cesium3DTileContentState.FAILED;');
    expect(failed).toBeGreaterThan(-1);
    expect(after.slice(0, failed)).not.toContain('request.cancelled');
  });
});
