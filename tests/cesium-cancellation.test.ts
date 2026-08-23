import { describe, expect, it } from 'vitest';
import { signalForRequest } from '../src/cesium-runtime/cancellation.js';

/** The two members of Cesium's `Request` this module touches, and nothing else. */
function fakeRequest() {
  return {
    cancelled: false,
    cancel(this: { cancelled: boolean }) {
      this.cancelled = true;
    },
  };
}

describe('signalForRequest', () => {
  it('fires when Cesium cancels the request', () => {
    const request = fakeRequest();
    const signal = signalForRequest(request);
    expect(signal?.aborted).toBe(false);
    request.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it('leaves the request cancelled the way Cesium expects', () => {
    // Cesium's own `processArrayBuffer` reads `request.cancelled` to decide
    // whether a rejected fetch means "failed" or "try again later". Wrapping
    // `cancel` must not cost that.
    const request = fakeRequest();
    signalForRequest(request);
    request.cancel();
    expect(request.cancelled).toBe(true);
  });

  it('does not fire on its own', () => {
    const request = fakeRequest();
    expect(signalForRequest(request)?.aborted).toBe(false);
  });

  it('wraps once, however many times it is asked', () => {
    const request = fakeRequest();
    const first = signalForRequest(request);
    const wrapped = request.cancel;
    const second = signalForRequest(request);
    expect(second).toBe(first);
    expect(request.cancel).toBe(wrapped);
  });

  it('returns an already-aborted signal for an already-cancelled request', () => {
    const request = fakeRequest();
    request.cancel();
    expect(signalForRequest(request)?.aborted).toBe(true);
  });

  it('returns undefined when there is no request to watch', () => {
    expect(signalForRequest(undefined)).toBeUndefined();
    expect(signalForRequest({})).toBeUndefined();
    expect(signalForRequest({ cancel: 'not a function' })).toBeUndefined();
  });
});
