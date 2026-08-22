import type { DecodeHeader } from '../src/worker/decode.js';
import type { EncodeRequest } from '../src/worker/pool.js';
import type { FromWorker, ToWorker, WorkerPort } from '../src/worker/protocol.js';

/**
 * Shared by tests/worker-pool.test.ts and tests/worker-pool-lifecycle.test.ts
 * the way tests/settled.ts is shared: both files drive the same pool through
 * the same hand-controlled `WorkerPort`, and duplicating that scaffolding
 * had already let the two copies drift — only one of them recorded
 * transfers.
 */

/** A minimal, structurally valid `DecodeHeader` — its field values are never read by the pool. */
export const HEADER: DecodeHeader = {
  pointDataRecordFormat: 7,
  pointDataRecordLength: 36,
  scale: [1, 1, 1],
  offset: [0, 0, 0],
};

export function request(): EncodeRequest {
  return { compressed: new ArrayBuffer(4), header: HEADER, pointCount: 1 };
}

export const DEFINITION = '+proj=longlat +datum=WGS84 +no_defs';

/** A `WorkerPort` the test drives by hand: it records what was posted and lets the test reply on demand. */
export class FakePort implements WorkerPort {
  readonly posted: ToWorker[] = [];
  // Parallel to `posted`: `transfers[i]` is the transfer list `post` received
  // alongside `posted[i]`. Kept as its own array, rather than folded into
  // `posted`, so assertions on message shape don't also have to thread a
  // transfer list through every `ToWorker` literal a test writes.
  readonly transfers: (readonly ArrayBuffer[])[] = [];
  // Arrays, not single fields: `WorkerPort.onMessage`/`onError`'s own doc
  // says a call adds a handler rather than replacing one, matching
  // `worker.on(...)` — a fake that instead kept only the latest would pass
  // every test that registers once and diverge from the real port the
  // moment something (this module's own tests included) registers twice.
  private readonly messageHandlers: ((message: FromWorker) => void)[] = [];
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  terminated = false;

  post(message: ToWorker, transfer: readonly ArrayBuffer[]): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  onMessage(handler: (message: FromWorker) => void): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers a reply as if the Worker realm had sent it, to every registered handler. */
  reply(message: FromWorker): void {
    for (const handler of this.messageHandlers) handler(message);
  }

  /** Delivers a port-level error, as if `worker.on('error', ...)` had fired, to every registered handler. */
  raiseError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}

/** A spawner the test controls: every port it hands out is recorded, in creation order. */
export function fakeSpawner(): { spawn: () => WorkerPort; ports: FakePort[] } {
  const ports: FakePort[] = [];
  return {
    spawn: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    ports,
  };
}

/** Replies `ready` to every `init` message a fake port has received so far. */
export function readyAll(ports: readonly FakePort[]): void {
  for (const port of ports) {
    for (const message of port.posted) {
      if (message.kind === 'init') port.reply({ kind: 'ready', id: message.id });
    }
  }
}

export function encodeMessages(port: FakePort): Extract<ToWorker, { kind: 'encode' }>[] {
  return port.posted.filter((message): message is Extract<ToWorker, { kind: 'encode' }> => message.kind === 'encode');
}

/** Total `encode` messages posted across every port the spawner has handed out. */
export function totalEncodeMessages(ports: readonly FakePort[]): number {
  return ports.reduce((sum, port) => sum + encodeMessages(port).length, 0);
}

/** The one port (if any) that has received an `encode` message, wherever it landed among `ports`. */
export function busyPort(ports: readonly FakePort[]): FakePort | undefined {
  return ports.find((port) => encodeMessages(port).length > 0);
}
