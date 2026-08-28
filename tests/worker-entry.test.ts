import { Las } from 'copc';
import { describe, expect, it, vi } from 'vitest';
import { readHierarchyPage } from '../src/copc/hierarchy.js';
import { registerCrs, resolveCrsDefinition } from '../src/crs/index.js';
import { createTransformFromDefinition } from '../src/crs/worker.js';
import { fromWire, ZeroPointChunkError } from '../src/errors/index.js';
import { createWorkerHandler } from '../src/worker/entry.js';
import { decodeChunk } from '../src/worker/decode.js';
import { encodePnts } from '../src/worker/pnts.js';
import { toRelativePositions } from '../src/worker/positions.js';
import type { FromWorker } from '../src/worker/protocol.js';
import { autzenWkt } from './autzen-wkt.js';
import { bufferReader } from './fake-reader.js';
import { fixtureBytes as fixture } from './fixtures.js';
import { createNodeWorkerPort } from './worker-port-node.js';

// A call-through mock: records the exact buffer `encodePnts` returns, before
// entry.ts (or anything downstream) has any chance to copy it. This is the
// independent reference the input-side transfer check already has (the
// `req.compressed` the test itself built) and the output side otherwise
// lacks — `pnts` is created inside `encodeNode`, not by this test, so
// without this, nothing distinguishes a move from a same-bytes copy. Only
// this test file's `createWorkerHandler`-driven tests run in this process,
// so this affects nothing else; the real-Worker tests below spawn a
// separate `node:worker_threads` Worker with its own module graph, which
// this mock never touches.
const pntsCalls = vi.hoisted((): ArrayBuffer[] => []);

vi.mock('../src/worker/pnts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/worker/pnts.js')>();
  return {
    ...actual,
    encodePnts: (...args: Parameters<typeof actual.encodePnts>) => {
      const result = actual.encodePnts(...args);
      pntsCalls.push(result);
      return result;
    },
  };
});

// Same proj4 definition tests/crs-transform.test.ts, tests/worker-positions.test.ts,
// tests/worker-pnts.test.ts, and tests/worker-pipeline.test.ts register for
// EPSG:2992 — Autzen's own horizontal system, in international feet.
const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Same shape tests/crs-transform.test.ts's own `+nadgrids` case uses: a table
// name other than the self-contained `@null` sentinel, which
// `createTransformFromDefinition` refuses before it ever builds a projection.
const NADGRIDS_DEFINITION = '+proj=lcc +nadgrids=conus +lat_0=41.75';

function collector() {
  const sent: FromWorker[] = [];
  const transfers: (readonly ArrayBuffer[])[] = [];
  const post = (message: FromWorker, transfer: readonly ArrayBuffer[]) => {
    sent.push(message);
    transfers.push(transfer);
  };
  return { sent, transfers, post };
}

/** Everything an 'init'/'encode' pair needs for the pinned chunk (node 5-16-3-1). */
async function loadNode() {
  const header = Las.Header.parse(fixture('autzen-head.bin'));
  const page = await readHierarchyPage(
    bufferReader(fixture('autzen-root-hierarchy.bin')),
    { offset: 0, length: fixture('autzen-root-hierarchy.bin').byteLength },
    header.pointCount,
  );
  const entry = page.nodes.find(
    (node) => node.key.depth === 5 && node.key.x === 16 && node.key.y === 3 && node.key.z === 1,
  );
  if (entry === undefined) {
    throw new Error('fixtures/autzen-root-hierarchy.bin no longer has node 5-16-3-1');
  }
  registerCrs(2992, OREGON);
  const definition = resolveCrsDefinition(await autzenWkt());
  return {
    header: {
      pointDataRecordFormat: header.pointDataRecordFormat,
      pointDataRecordLength: header.pointDataRecordLength,
      scale: header.scale,
      offset: header.offset,
    },
    pointCount: entry.pointCount,
    definition,
  };
}

describe('createWorkerHandler', () => {
  it('replies ready to an init carrying a usable definition', async () => {
    const { sent, post } = collector();
    const handler = createWorkerHandler(post);

    await handler({ kind: 'init', id: 1, definition: OREGON });

    expect(sent).toEqual([{ kind: 'ready', id: 1 }]);
  });

  it('replies failed, with the CRS guard\'s own code, to an init the Worker cannot use', async () => {
    const { sent, post } = collector();
    const handler = createWorkerHandler(post);

    await handler({ kind: 'init', id: 1, definition: NADGRIDS_DEFINITION });

    expect(sent).toHaveLength(1);
    const reply = sent[0];
    if (reply?.kind !== 'failed') {
      throw new Error(`expected a failed reply, got ${JSON.stringify(reply)}`);
    }
    expect(reply.error.code).toBe('crs-definition-unusable');

    // A failed init must not leave the handler usable: an encode that follows
    // has to be refused the same way one sent before any init would be.
    // `entry.ts` holds that structurally — the transform is assigned only when
    // `createTransformFromDefinition` returns, so a failed init leaves it
    // `undefined` and the encode below never reaches `encodeNode` at all.
    // This assertion is what catches an edit that assigned it before probing
    // it: there is no second throw further down the pipeline to fall back on
    // any more, since `encodeNode` no longer builds a transform of its own.
    await handler({
      kind: 'encode',
      id: 2,
      compressed: new ArrayBuffer(0),
      header: {
        pointDataRecordFormat: 7,
        pointDataRecordLength: 36,
        scale: [1, 1, 1],
        offset: [0, 0, 0],
      },
      pointCount: 1,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.kind).toBe('failed');
  });

  it('replies failed, naming the ordering, to an encode sent before any init succeeded', async () => {
    const { sent, post } = collector();
    const handler = createWorkerHandler(post);

    await handler({
      kind: 'encode',
      id: 1,
      compressed: new ArrayBuffer(0),
      header: {
        pointDataRecordFormat: 7,
        pointDataRecordLength: 36,
        scale: [1, 1, 1],
        offset: [0, 0, 0],
      },
      pointCount: 1,
    });

    expect(sent).toHaveLength(1);
    const reply = sent[0];
    if (reply?.kind !== 'failed') {
      throw new Error(`expected a failed reply, got ${JSON.stringify(reply)}`);
    }
    expect(reply.error.message).toMatch(/initialis/);
  });

  describe('against the pinned chunk (node 5-16-3-1)', () => {
    it('replies done with a pnts buffer, listed exactly once as the transfer', async () => {
      pntsCalls.length = 0; // isolate this test's own call to the mock above
      const { header, pointCount, definition } = await loadNode();
      const { sent, transfers, post } = collector();
      const handler = createWorkerHandler(post);

      await handler({ kind: 'init', id: 1, definition });
      await handler({
        kind: 'encode',
        id: 2,
        compressed: fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer,
        header,
        pointCount,
      });

      expect(sent).toHaveLength(2);
      const reply = sent[1];
      if (reply?.kind !== 'done') {
        throw new Error(`expected a done reply, got ${JSON.stringify(reply)}`);
      }
      const magic = new TextDecoder().decode(new Uint8Array(reply.pnts, 0, 4));
      expect(magic).toBe('pnts');

      // The independent reference: the exact buffer `encodePnts` returned,
      // captured by the module-level mock before entry.ts had any chance to
      // copy it.
      expect(pntsCalls).toHaveLength(1);
      const original = pntsCalls[0];
      expect(transfers[1]).toHaveLength(1);
      // `toBe`, not `toEqual`, and against `original` rather than against
      // each other: two distinct ArrayBuffers holding identical bytes are
      // `toEqual`-equal, and comparing the message's `pnts` only to the
      // transfer list's own entry would even let a handler that posts the
      // *same* copy in both places (`const copy = pnts.slice(0); post({...,
      // pnts: copy}, [copy])`) pass, since the two would then agree with
      // each other while still not being the buffer `encodePnts` produced.
      // Anchoring both checks to `original` — captured independently of
      // entry.ts, the same way tests/worker-pool.test.ts's own
      // `toBe`-not-`toEqual` check for the input buffer anchors to
      // `req.compressed` — catches that case too (OVERVIEW §3 Decision 3).
      expect(reply.pnts).toBe(original);
      expect(transfers[1]?.[0]).toBe(original);
    });

    it('replies failed with zero-point-chunk for a chunk whose pointCount is 0', async () => {
      const { header, definition } = await loadNode();
      const { sent, post } = collector();
      const handler = createWorkerHandler(post);

      await handler({ kind: 'init', id: 1, definition });
      await handler({
        kind: 'encode',
        id: 2,
        compressed: new ArrayBuffer(0),
        header,
        pointCount: 0,
      });

      expect(sent).toHaveLength(2);
      const reply = sent[1];
      if (reply?.kind !== 'failed') {
        throw new Error(`expected a failed reply, got ${JSON.stringify(reply)}`);
      }
      expect(reply.error.code).toBe('zero-point-chunk');
    });

    it('echoes the request id back, for an id that is neither 0 nor 1', async () => {
      const { header, pointCount, definition } = await loadNode();
      const { sent, post } = collector();
      const handler = createWorkerHandler(post);

      await handler({ kind: 'init', id: 42, definition });
      await handler({
        kind: 'encode',
        id: 917,
        compressed: fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer,
        header,
        pointCount,
      });

      expect(sent[0]?.id).toBe(42);
      expect(sent[1]?.id).toBe(917);
    });
  });
});

describe('createWorkerHandler carries the geoid height', () => {
  /** Runs one init/encode pair and returns the pnts bytes it replied with. */
  const encodeWith = async (geoidHeight?: number): Promise<Uint8Array> => {
    const { header, pointCount, definition } = await loadNode();
    const { sent, post } = collector();
    const handler = createWorkerHandler(post);

    await handler({
      kind: 'init',
      id: 1,
      definition,
      ...(geoidHeight !== undefined && { geoidHeight }),
    });
    await handler({
      kind: 'encode',
      id: 2,
      compressed: fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer,
      header,
      pointCount,
    });

    const reply = sent[1];
    if (reply?.kind !== 'done') {
      throw new Error(`expected a done reply, got ${JSON.stringify(reply)}`);
    }
    return new Uint8Array(reply.pnts);
  };

  // The height rides one init message and has to outlive it: every encode
  // afterwards builds its own transform, and a handler that stored the
  // definition but dropped the height would still answer done — with points
  // in the wrong place.
  it('applies an init geoid height to a later encode', async () => {
    const plain = await encodeWith();
    const lowered = await encodeWith(-23.333);

    expect(lowered.byteLength).toBe(plain.byteLength);
    expect(lowered).not.toEqual(plain);
  });

  it('encodes identically when no height is given', async () => {
    expect(await encodeWith()).toEqual(await encodeWith(0));
  });
});

describe('against a real node:worker_threads Worker', () => {
  // WASM initialisation in a fresh Worker is not instant: measured directly
  // (`node --import tests/worker-hook.mjs`, this machine, 3 runs) at
  // 215-225ms from posting 'init' to receiving 'ready', 234-246ms end to end
  // including the encode round trip. Under this suite (`npx vitest run
  // tests/worker-entry.test.ts --reporter=verbose`, this machine) each of
  // the three tests below took 236-263ms. 15s leaves nearly two orders of
  // magnitude of headroom without hiding a real hang: a defect in the
  // pipeline these tests exercise (decodeChunk, toRelativePositions,
  // encodePnts) throws synchronously, and entry.ts's own try/catch turns
  // that into a fast `failed` reply rather than a stall — confirmed by
  // making decodeChunk always throw, which failed this suite in about a
  // second, not by waiting out this timeout.
  const WORKER_TEST_TIMEOUT = 15_000;

  /** Resolves with the next message the port delivers, or rejects on a Worker error. */
  function nextMessage(port: ReturnType<typeof createNodeWorkerPort>): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      port.onError(reject);
      port.onMessage(resolve);
    });
  }

  it(
    'round-trips the pinned chunk byte-identical to the main-thread encoder',
    async () => {
      const { header, pointCount, definition } = await loadNode();

      // The same chunk, encoded on the main thread, to compare the Worker's
      // reply against byte-for-byte — a length check alone would pass even
      // against a buffer of zeros.
      const view = await decodeChunk(fixture('autzen-node-5-16-3-1.bin'), header, pointCount);
      const transform = createTransformFromDefinition(definition);
      const placed = toRelativePositions(view, transform);
      const expected = new Uint8Array(encodePnts(view, placed));

      const port = createNodeWorkerPort();
      try {
        const ready = nextMessage(port);
        port.post({ kind: 'init', id: 1, definition }, []);
        expect(await ready).toEqual({ kind: 'ready', id: 1 });

        const compressed = fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer;
        const done = nextMessage(port);
        port.post({ kind: 'encode', id: 2, compressed, header, pointCount }, [compressed]);

        const reply = await done;
        if (reply.kind !== 'done') {
          throw new Error(`expected a done reply, got ${JSON.stringify(reply)}`);
        }
        const magic = new TextDecoder().decode(new Uint8Array(reply.pnts, 0, 4));
        expect(magic).toBe('pnts');
        expect(new Uint8Array(reply.pnts)).toEqual(expected);
      } finally {
        port.terminate();
      }
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    'neuters the submitted buffer on transfer and returns a non-empty one',
    async () => {
      const { header, pointCount, definition } = await loadNode();

      const port = createNodeWorkerPort();
      try {
        const ready = nextMessage(port);
        port.post({ kind: 'init', id: 1, definition }, []);
        await ready;

        const compressed = fixture('autzen-node-5-16-3-1.bin').buffer as ArrayBuffer;
        const done = nextMessage(port);
        port.post({ kind: 'encode', id: 2, compressed, header, pointCount }, [compressed]);

        // Structured clone neuters a transferred buffer synchronously, on
        // the sending side, before the Worker has done anything with it.
        expect(compressed.byteLength).toBe(0);

        const reply = await done;
        if (reply.kind !== 'done') {
          throw new Error(`expected a done reply, got ${JSON.stringify(reply)}`);
        }
        expect(reply.pnts.byteLength).toBeGreaterThan(0);
      } finally {
        port.terminate();
      }
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    'surfaces a Worker-side ZeroPointChunkError through fromWire with its code intact',
    async () => {
      const { header, definition } = await loadNode();

      const port = createNodeWorkerPort();
      try {
        const ready = nextMessage(port);
        port.post({ kind: 'init', id: 1, definition }, []);
        await ready;

        const failed = nextMessage(port);
        port.post(
          { kind: 'encode', id: 2, compressed: new ArrayBuffer(0), header, pointCount: 0 },
          [],
        );
        const reply = await failed;
        if (reply.kind !== 'failed') {
          throw new Error(`expected a failed reply, got ${JSON.stringify(reply)}`);
        }
        expect(reply.error.code).toBe('zero-point-chunk');

        const rebuilt = fromWire(reply.error);
        expect(rebuilt).toBeInstanceOf(ZeroPointChunkError);
        expect(rebuilt.code).toBe('zero-point-chunk');
      } finally {
        port.terminate();
      }
    },
    WORKER_TEST_TIMEOUT,
  );
});
