import { parentPort } from 'node:worker_threads';
import { createWorkerHandler } from '../src/worker/entry.js';
import type { ToWorker } from '../src/worker/protocol.js';

const port = parentPort;
if (port === null) {
  throw new Error('this module only runs inside a Worker');
}

const handle = createWorkerHandler((message, transfer) => {
  port.postMessage(message, transfer as ArrayBuffer[]);
});

port.on('message', (message: ToWorker) => {
  void handle(message);
});
