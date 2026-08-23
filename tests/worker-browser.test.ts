import { describe, expect, it, vi } from 'vitest';
import { createWorkerHandler, installWorkerHandler } from '../src/worker/browser.js';

/** The five-line shape `browser.ts` needs from a Worker global. */
function fakeScope() {
  return {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
  };
}

describe('the browser Worker module', () => {
  it('re-exports the handler factory so a caller can build their own Worker', () => {
    expect(typeof createWorkerHandler).toBe('function');
  });

  it('installs a message handler on the scope it is given', () => {
    const scope = fakeScope();
    installWorkerHandler(scope as never);
    expect(typeof scope.onmessage).toBe('function');
  });

  it('did not install itself just by being imported here', () => {
    // This test file is a main-thread realm: importing the module must not
    // have reached for a global. If the guard is wrong, an accidental
    // main-thread import hijacks whatever `onmessage` the page owns.
    expect((globalThis as { onmessage?: unknown }).onmessage ?? null).toBe(null);
  });

  it('answers an init message through the scope it installed on', async () => {
    const scope = fakeScope();
    installWorkerHandler(scope as never);
    scope.onmessage?.({
      data: { kind: 'init', id: 1, definition: '+proj=longlat +datum=WGS84 +no_defs' },
    });
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalled());
    expect(scope.postMessage.mock.calls[0]?.[0]).toMatchObject({ kind: 'ready', id: 1 });
  });
});
