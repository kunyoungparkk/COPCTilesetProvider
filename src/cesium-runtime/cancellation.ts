/**
 * Cesium's tile cancellation, as an `AbortSignal`.
 *
 * `Cesium3DTileset` cancels a tile that is still `LOADING` after a frame out
 * of view, which reaches `Cesium3DTile.cancelRequests` and then
 * `Request.prototype.cancel` — a method whose entire body is
 * `this.cancelled = true`. Nothing else happens: `RequestScheduler`'s
 * `cancelFunction` never runs for our requests, because
 * `ScheduledRangeResource.fetchArrayBuffer` overrides Cesium's own and never
 * enters the scheduler. So the only moment available is the `cancel` call
 * itself, and this wraps it.
 *
 * The wrap goes on the instance, not the prototype: every other request in
 * the application keeps the method it had. Cesium builds a fresh `Request`
 * per tile request (`Cesium3DTile.js`, `requestSingleContent`), so each one
 * is wrapped at most once and is garbage along with its tile.
 *
 * Aborting a Range read is safe in a way aborting a decode is not. Cesium's
 * catch around the request promise checks `request.cancelled` and restores
 * the tile's previous state; its catch around `makeContent` does not, and
 * fails the tile terminally. `tests/cesium-contract.test.ts` pins both, so
 * the day that asymmetry changes is the day this can cover decodes too.
 */

/** Marks a request whose `cancel` this module has already wrapped. */
const SIGNAL = Symbol.for('copc-tileset-provider.cancellation');

interface CancellableRequest {
  cancelled?: boolean;
  cancel(): void;
  [SIGNAL]?: AbortSignal;
}

function isCancellable(request: unknown): request is CancellableRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    typeof (request as { cancel?: unknown }).cancel === 'function'
  );
}

/**
 * An `AbortSignal` that fires when Cesium cancels `request`, or `undefined`
 * when there is no request to watch.
 *
 * `undefined` is not an error: a `Resource` fetched outside a tile request
 * has no Cesium `Request` behind it, and that read is simply not cancellable.
 */
export function signalForRequest(request: unknown): AbortSignal | undefined {
  if (!isCancellable(request)) return undefined;

  const existing = request[SIGNAL];
  if (existing !== undefined) return existing;

  const controller = new AbortController();
  request[SIGNAL] = controller.signal;

  if (request.cancelled === true) {
    controller.abort();
    return controller.signal;
  }

  const cancel = request.cancel.bind(request);
  request.cancel = () => {
    // Cesium's own behaviour first: `processArrayBuffer` reads `cancelled` to
    // tell "try again later" from "failed", so it has to be set either way.
    cancel();
    controller.abort();
  };

  return controller.signal;
}
