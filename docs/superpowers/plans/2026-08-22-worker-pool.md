# Worker Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the PNTS pipeline off the main thread — a pool of Workers, a message protocol both realms agree on, and admission that reuses the budget's own three-way verdict instead of a second queue.

**Architecture:** `src/worker/` gains a main-thread half. `pool.ts` owns ports, the task table and cancellation but never constructs a platform `Worker`; `entry.ts` is a platform-free message handler the Worker realm runs; `protocol.ts` is the only file both realms import. Typed errors cross the boundary as `{ code, name, message, stack }` and are rebuilt into their original classes on arrival.

**Tech Stack:** TypeScript 7 (ESM, `erasableSyntaxOnly`), Vitest, `node:worker_threads` for real-Worker tests, the existing `src/budget/` module. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-22-worker-pool-design.md`

## Global Constraints

- **Node 22 is required.** The default `node` is v18 and Vitest dies at startup. Prefix every command with `export PATH=/home/kyp/.local/node22/bin:$PATH`.
- **No new dependencies.** OVERVIEW §5 fixes the runtime list at `copc.js`, `laz-perf`, `proj4`; `tests/manifest.test.ts` pins it.
- **Tests never touch the network.** Committed fixtures under `fixtures/` only.
- **English** for code, comments, commit messages. Commits `type(scope): summary`, imperative, under 72 chars; the body explains *why* and cites the OVERVIEW decision when one applies.
- **`tsc --noEmit` clean** under `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. Imports carry `.js`.
- **Green in all three isolation modes:** `npm test`, `npx vitest run --no-isolate`, `npx vitest run --no-isolate --fileParallelism=false`.
- **Two CLAUDE.md rules bind every task:** write what a test catches only after running the mutation that decides it; comments state what is true *now*, and history goes in the commit body — **never a pointer to `.superpowers/`, which is gitignored and does not ship.** This project has shipped that defect three times. Run `grep -rn "\.superpowers" src/ tests/` before every commit.
- **Do not edit `OVERVIEW.md`.** If you believe it needs changing, say so in your report.

## Numbers in this plan

Baseline at the time of writing: **337 tests / 32 files**, `tsc --noEmit` clean. Re-derive with `npm test` rather than trusting it.

Every other figure here is either read from a file in the repository or comes with the command that produces it. A number you cannot re-derive is a rumour — six numbers in an earlier plan for this project were wrong, and each was found by an implementer running rather than transcribing.

## Two refinements to the spec, decided here

1. **`entry.ts` is a handler factory, not a bootstrap.** The spec calls it "receives messages, calls `encodeNode`, posts results". A browser Worker receives through `self.onmessage`; a `node:worker_threads` Worker receives through `parentPort.on('message')`. If `entry.ts` hardcodes either, the spec's own requirement — that tests drive a *real* Worker — becomes impossible on Node. So `entry.ts` exports `createWorkerHandler(post)` and the four lines of platform wiring live in a bootstrap: `tests/worker-entry-node.ts` now, the browser one with the bundling sub-project. The realm boundary is unaffected — the walk targets `entry.ts`.
2. **The main-thread file is `pool.ts`, and `index.ts` stays the Worker-realm barrel.** In `src/crs/` the main realm is `index.ts` and the Worker realm is `worker.ts`; here it is inverted, which is a wart. It is the lesser one: `src/worker/index.ts` is the pipeline's own barrel, `tests/worker-boundary.test.ts` already walks it as a Worker-realm entry, and renaming it churns every import for a naming symmetry. `src/worker/README.md` states which file belongs to which realm, and Task 6's boundary assertions enforce it.

## File Structure

- `src/errors/wire.ts` — **create.** `WireError`, `toWire`, `fromWire`, and the `code → constructor` map.
- `src/errors/worker.ts` — **modify.** Add `WorkerTaskFailedError`.
- `src/errors/index.ts` — **modify.** Re-export both.
- `src/worker/protocol.ts` — **create.** `ToWorker`, `FromWorker`, `WorkerPort`. The only file both realms import.
- `src/worker/entry.ts` — **create.** `createWorkerHandler`. Worker realm.
- `src/worker/pool.ts` — **create.** `createWorkerPool`, `WorkerPool`, `EncodeVerdict`. Main realm. Re-exports `WorkerPort`.
- `src/worker/README.md` — **modify.** Both realms, and which file is which.
- `tests/worker-hook.mjs`, `tests/worker-resolve-ts.mjs` — **create.** The `.js`→`.ts` resolve hook. Plain JS, not TypeScript: they run before Node's type stripping applies to them.
- `tests/worker-entry-node.ts` — **create.** The `node:worker_threads` bootstrap.
- `tests/worker-port-node.ts` — **create.** `WorkerPort` over `node:worker_threads.Worker`.
- `tests/errors-wire.test.ts`, `tests/worker-entry.test.ts`, `tests/worker-pool.test.ts`, `tests/worker-pool-lifecycle.test.ts` — **create.**
- `tests/worker-boundary.test.ts` — **modify.** Task 6.

---

### Task 1: Errors that survive the boundary

**Files:**
- Create: `src/errors/wire.ts`
- Modify: `src/errors/worker.ts`, `src/errors/index.ts`
- Test: `tests/errors-wire.test.ts`

**Interfaces:**
- Produces: `interface WireError { readonly code: string | null; readonly name: string; readonly message: string; readonly stack: string | undefined }`, `toWire(thrown: unknown): WireError`, `fromWire(wire: WireError): CopcTilesetError`, and `class WorkerTaskFailedError extends CopcTilesetError` with `code = 'worker-task-failed'`.

Structured clone erases class identity: a `ZeroPointChunkError` thrown in a Worker arrives as a plain object with no prototype and no `code`. Decision 6 makes errors part of the API, so both `instanceof` and `.code` have to mean the same thing on both sides.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CopcTilesetError,
  CrsNotRegisteredError,
  MalformedHierarchyError,
  WorkerTaskFailedError,
  ZeroPointChunkError,
  fromWire,
  toWire,
} from '../src/errors/index.js';

// Structured clone is what the Worker boundary does to a thrown value, and
// it is the reason this module exists: it keeps own enumerable properties
// and discards the prototype. Round-tripping through it rather than through
// a hand-written object literal means these tests fail if that assumption
// about the platform is ever wrong.
const cloned = (wire: unknown) => structuredClone(wire) as ReturnType<typeof toWire>;

describe('toWire / fromWire', () => {
  it('rebuilds a library error as its own class, with its code and message', () => {
    const original = new CrsNotRegisteredError(2992);

    const rebuilt = fromWire(cloned(toWire(original)));

    expect(rebuilt).toBeInstanceOf(CrsNotRegisteredError);
    expect(rebuilt.code).toBe('crs-not-registered');
    expect(rebuilt.message).toBe(original.message);
    expect(rebuilt.name).toBe('CrsNotRegisteredError');
  });

  // The message is transported rather than recomposed. Constructors here take
  // different arguments — a code, a url and a detail, nothing — so rebuilding
  // by calling one would need the arguments back, and the arguments are not
  // what crossed.
  it('keeps a message the constructor could not recompute', () => {
    const original = new MalformedHierarchyError('https://host/a.copc.laz', 'its entry "9-9-9-9" lies');

    const rebuilt = fromWire(cloned(toWire(original)));

    expect(rebuilt.message).toContain('https://host/a.copc.laz');
    expect(rebuilt.message).toContain('9-9-9-9');
  });

  it('carries the stack from the realm that threw', () => {
    const original = new ZeroPointChunkError();

    const rebuilt = fromWire(cloned(toWire(original)));

    expect(rebuilt.stack).toBe(original.stack);
  });

  // laz-perf throwing, or V8 refusing an allocation. It is still typed, so a
  // caller can branch on it, and it does not pretend to be one of ours.
  it('wraps a foreign error rather than inventing a code for it', () => {
    const rebuilt = fromWire(cloned(toWire(new RangeError('Array buffer allocation failed'))));

    expect(rebuilt).toBeInstanceOf(WorkerTaskFailedError);
    expect(rebuilt.code).toBe('worker-task-failed');
    expect(rebuilt.message).toContain('RangeError');
    expect(rebuilt.message).toContain('Array buffer allocation failed');
  });

  it('survives a thrown value that is not an Error at all', () => {
    const rebuilt = fromWire(cloned(toWire('a bare string')));

    expect(rebuilt).toBeInstanceOf(WorkerTaskFailedError);
    expect(rebuilt.message).toContain('a bare string');
  });

  // The map is the drift risk: add an error class, forget the map, and every
  // instance of it silently degrades to WorkerTaskFailedError on the way
  // back. Scanning the source is what makes forgetting impossible, the same
  // shape tests/import-closure.test.ts uses against the real src/ tree.
  it('knows every error code declared under src/errors', () => {
    const directory = fileURLToPath(new URL('../src/errors/', import.meta.url));
    const declared = readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => [...readFileSync(`${directory}${name}`, 'utf8').matchAll(/readonly code = '([^']+)'/g)])
      .map((match) => match[1]);

    // Guards the guard: a regex that stops matching would make this pass on
    // an empty set.
    expect(declared.length).toBeGreaterThan(15);

    for (const code of declared) {
      const rebuilt = fromWire({ code: code ?? '', name: 'X', message: 'm', stack: undefined });
      expect(rebuilt.code, `code ${code} is missing from the wire map`).toBe(code);
    }
  });
});
```

- [ ] **Step 2: Run and watch fail**

```
export PATH=/home/kyp/.local/node22/bin:$PATH
npx vitest run tests/errors-wire.test.ts
```
Expected: fails to import `fromWire`, `toWire`, `WorkerTaskFailedError`.

- [ ] **Step 3: Implement**

`src/errors/worker.ts` gains:

```ts
/**
 * Something failed inside a Worker that this library did not throw — laz-perf
 * rejecting a chunk, V8 refusing an allocation, a bug.
 *
 * It stays typed so a caller can branch on it, and it names the original
 * error rather than paraphrasing: the Worker realm has no stack the main
 * thread can walk, so the text is all that survives.
 */
export class WorkerTaskFailedError extends CopcTilesetError {
  readonly code = 'worker-task-failed';

  constructor(name: string, message: string) {
    super(
      `A Worker failed to encode a tile, with an error this library did not raise:\n\n` +
        `    ${name}: ${message}\n\n` +
        'That is either a defect in this library or a file its decoder cannot read. ' +
        'The original error above is what the Worker realm reported.',
    );
  }
}
```

`src/errors/wire.ts`:

```ts
import { CopcTilesetError } from './base.js';
import { LeaseAlreadyReleasedError } from './budget.js';
import {
  MalformedHierarchyError,
  NotCopcError,
  UnsupportedHeaderLayoutError,
  WktNotInVlrsError,
} from './copc.js';
import { CrsCodeNotFoundError, CrsDefinitionUnusableError, CrsNotRegisteredError } from './crs.js';
import {
  ContentRangeMismatchError,
  ContentRangeUnreadableError,
  InvalidByteRangeError,
  RangeNetworkError,
  RangeRequestFailedError,
  RangeTimeoutError,
  RangeUnsupportedError,
} from './range.js';
import { PositionCountMismatchError, WorkerTaskFailedError, ZeroPointChunkError } from './worker.js';

/**
 * A thrown value flattened into something `postMessage` can carry.
 *
 * `code` is `null` for anything this library did not throw.
 */
export interface WireError {
  readonly code: string | null;
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

// Every error class this library can throw, by its code. `tests/errors-wire.test.ts`
// scans src/errors for `readonly code` declarations and fails if one is missing
// here, because a missing entry degrades that error to WorkerTaskFailedError on
// the way back and nothing else would notice.
// Only `.prototype` is ever read, so the value type says that and nothing more.
const BY_CODE: ReadonlyMap<string, { readonly prototype: CopcTilesetError }> = new Map([
  ['content-range-mismatch', ContentRangeMismatchError],
  ['content-range-unreadable', ContentRangeUnreadableError],
  ['crs-code-not-found', CrsCodeNotFoundError],
  ['crs-definition-unusable', CrsDefinitionUnusableError],
  ['crs-not-registered', CrsNotRegisteredError],
  ['invalid-byte-range', InvalidByteRangeError],
  ['lease-already-released', LeaseAlreadyReleasedError],
  ['malformed-hierarchy', MalformedHierarchyError],
  ['not-copc', NotCopcError],
  ['position-count-mismatch', PositionCountMismatchError],
  ['range-network', RangeNetworkError],
  ['range-request-failed', RangeRequestFailedError],
  ['range-timeout', RangeTimeoutError],
  ['range-unsupported', RangeUnsupportedError],
  ['unsupported-header-layout', UnsupportedHeaderLayoutError],
  ['wkt-not-in-vlrs', WktNotInVlrsError],
  ['worker-task-failed', WorkerTaskFailedError],
  ['zero-point-chunk', ZeroPointChunkError],
] as const);

/** Flattens anything a Worker can throw. */
export function toWire(thrown: unknown): WireError {
  if (thrown instanceof CopcTilesetError) {
    return { code: thrown.code, name: thrown.name, message: thrown.message, stack: thrown.stack };
  }
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  return { code: null, name: error.name, message: error.message, stack: error.stack };
}

/**
 * Rebuilds the error the Worker threw.
 *
 * The instance is built from the prototype rather than by calling the
 * constructor, because the constructors take different arguments — an EPSG
 * code, a url and a detail, nothing at all — and none of those arguments
 * crossed the boundary. The composed message did, and it is the part callers
 * read. Rebuilding it any other way would need the arguments back.
 */
export function fromWire(wire: WireError): CopcTilesetError {
  const constructor = wire.code === null ? undefined : BY_CODE.get(wire.code);
  if (constructor === undefined) {
    return new WorkerTaskFailedError(wire.name, wire.message);
  }
  const rebuilt = Object.create(constructor.prototype) as {
    code: string;
    name: string;
    message: string;
    stack: string | undefined;
  };
  rebuilt.code = wire.code as string;
  rebuilt.name = wire.name;
  rebuilt.message = wire.message;
  rebuilt.stack = wire.stack;
  return rebuilt as unknown as CopcTilesetError;
}
```

`src/errors/index.ts` re-exports `WorkerTaskFailedError`, `toWire`, `fromWire`, and `type WireError`.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Delete one entry from `BY_CODE`. Expected: the scan test names that code.
2. Make `toWire` drop `stack`. Expected: the stack test reddens.
3. Make `fromWire` return `new WorkerTaskFailedError(...)` unconditionally. Expected: the first two tests redden, the foreign-error test stays green.
4. Break the scan regex to `/readonly code = "([^"]+)"/` (double quotes, which the source never uses). Expected: the `length > 15` guard reddens rather than the loop passing on an empty set.

Report any that reddens nothing.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(errors): carry a typed error across a realm boundary"
```

---

### Task 2: The protocol, and a platform-free Worker handler

**Files:**
- Create: `src/worker/protocol.ts`, `src/worker/entry.ts`
- Test: `tests/worker-entry.test.ts`

**Interfaces:**
- Consumes: `encodeNode` and `DecodeHeader` from `src/worker/index.js`; `toWire` from `src/errors/index.js`.
- Produces: `type ToWorker`, `type FromWorker`, `interface WorkerPort`, and `createWorkerHandler(post: (message: FromWorker, transfer: readonly ArrayBuffer[]) => void): (message: ToWorker) => Promise<void>`.
- **`WorkerPort` is declared here, not in `pool.ts`.** Task 3 writes an implementation of it and runs before Task 4, so declaring it in the pool would be a forward dependency across a task boundary. The port is how the protocol travels, and the type is erased at runtime, so a Worker importing it costs nothing.

- [ ] **Step 1: Write the failing test**

Drive the handler directly, with no Worker involved — Task 3 adds the real one. This test is about the state machine.

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';
import { createWorkerHandler } from '../src/worker/entry.js';
import type { FromWorker } from '../src/worker/protocol.js';
import { readHierarchyPage } from '../src/copc/hierarchy.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

function collector() {
  const sent: FromWorker[] = [];
  const transfers: (readonly ArrayBuffer[])[] = [];
  const post = (message: FromWorker, transfer: readonly ArrayBuffer[]) => {
    sent.push(message);
    transfers.push(transfer);
  };
  return { sent, transfers, post };
}
```

Tests to write, each its own `it` so a failure names the property that failed:

1. `init` with a usable definition replies `{ kind: 'ready', id }`.
2. `init` with `'+proj=lcc +nadgrids=conus +lat_0=41.75'` replies `failed` whose `error.code` is `crs-definition-unusable` — the guard `createTransformFromDefinition` already carries, reaching the main thread as a code rather than a crash.
3. `encode` before a successful `init` replies `failed` rather than throwing. Whatever the message says, it must name the ordering rather than surfacing a `TypeError` about an undefined definition.
4. `encode` on the pinned chunk replies `{ kind: 'done' }` with a buffer whose first four bytes are `pnts`, and lists exactly that buffer as its transfer.
5. `encode` on a chunk whose `pointCount` is 0 replies `failed` with code `zero-point-chunk`.
6. The reply's `id` equals the request's `id`, for a request id that is not 0 or 1 — so an implementation that echoes a constant, or an index, fails.

Get the pinned chunk the way `tests/worker-pnts.test.ts` does, including the real header point count for `readHierarchyPage`:

```ts
const header = Las.Header.parse(fixture('autzen-head.bin'));
const page = await readHierarchyPage(
  bufferReader(fixture('autzen-root-hierarchy.bin')),
  { offset: 0, length: fixture('autzen-root-hierarchy.bin').byteLength },
  header.pointCount,
);
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`src/worker/protocol.ts`:

```ts
import type { WireError } from '../errors/index.js';
import type { DecodeHeader } from './index.js';

/**
 * The messages the two realms exchange, and the whole of their agreement.
 *
 * There is no `cancel` message, deliberately. A task the pool has not posted
 * yet is cancelled by the pool forgetting it — the Worker never heard of it.
 * A task it has posted is inside a synchronous laz-perf decode that owns the
 * Worker's event loop, so a cancel message would not be read until the work
 * it meant to stop had already finished. See the design doc; adding one would
 * be adding a message that cannot do its job.
 */
export type ToWorker =
  | { readonly kind: 'init'; readonly id: number; readonly definition: string }
  | {
      readonly kind: 'encode';
      readonly id: number;
      readonly compressed: ArrayBuffer;
      readonly header: DecodeHeader;
      readonly pointCount: number;
    };

export type FromWorker =
  | { readonly kind: 'ready'; readonly id: number }
  | { readonly kind: 'done'; readonly id: number; readonly pnts: ArrayBuffer }
  | { readonly kind: 'failed'; readonly id: number; readonly error: WireError };

/**
 * One Worker, as much of it as this library needs.
 *
 * A browser `Worker` and a `node:worker_threads.Worker` are not structurally
 * compatible — `addEventListener` against `on` — so one of them needs an
 * adapter whatever we do. Naming the six methods we actually use keeps the
 * DOM's `Transferable` out of a library that must typecheck under
 * `@types/node`, and states the whole platform surface in one place.
 *
 * `ArrayBuffer[]` rather than `Transferable[]`: buffers are the only thing
 * this protocol ever transfers.
 */
export interface WorkerPort {
  post(message: ToWorker, transfer: readonly ArrayBuffer[]): void;
  onMessage(handler: (message: FromWorker) => void): void;
  onError(handler: (error: Error) => void): void;
  terminate(): void;
}
```

`src/worker/entry.ts`:

```ts
import { createTransformFromDefinition } from '../crs/worker.js';
import { toWire } from '../errors/index.js';
import { encodeNode } from './index.js';
import type { FromWorker, ToWorker } from './protocol.js';

/**
 * The Worker realm's message handler, without the platform wiring.
 *
 * A browser Worker receives through `self.onmessage` and a
 * `node:worker_threads` one through `parentPort.on('message')`. Hardcoding
 * either would make the other untestable, and testing against a real Worker
 * is the only way structured clone and transferable handoff get checked at
 * all. So the four lines that differ live in a bootstrap and this file holds
 * everything that does not.
 */
export function createWorkerHandler(
  post: (message: FromWorker, transfer: readonly ArrayBuffer[]) => void,
): (message: ToWorker) => Promise<void> {
  let definition: string | undefined;

  return async (message) => {
    if (message.kind === 'init') {
      // Building a transform here is what proves the definition is usable in
      // this realm before any tile depends on it: `createTransformFromDefinition`
      // refuses a `+nadgrids` table or a `proj4.defs` alias, neither of which
      // a Worker can resolve.
      try {
        // The result is discarded: `encodeNode` builds its own per call, and
        // §7 takes an optimisation from measurement rather than from reasoning.
        // What this call is for is the throw — it refuses a `+nadgrids` table
        // or a `proj4.defs` alias, neither of which a Worker can resolve, and
        // refusing here means no tile ever depends on a definition this realm
        // cannot use.
        createTransformFromDefinition(message.definition);
        definition = message.definition;
        post({ kind: 'ready', id: message.id }, []);
      } catch (thrown) {
        post({ kind: 'failed', id: message.id, error: toWire(thrown) }, []);
      }
      return;
    }

    if (definition === undefined) {
      post(
        {
          kind: 'failed',
          id: message.id,
          error: toWire(new Error('this Worker was asked to encode before it was initialised')),
        },
        [],
      );
      return;
    }

    try {
      const pnts = await encodeNode({
        compressed: new Uint8Array(message.compressed),
        header: message.header,
        pointCount: message.pointCount,
        definition,
      });
      post({ kind: 'done', id: message.id, pnts }, [pnts]);
    } catch (thrown) {
      post({ kind: 'failed', id: message.id, error: toWire(thrown) }, []);
    }
  };
}
```

**Note for the implementer:** `src/crs/worker.ts` is the Worker-realm CRS entry point and is already inside `pipeline.ts`'s import closure, so importing it here widens nothing. Confirm that with Task 6's boundary walk rather than assuming it.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Post `pnts` without listing it in `transfer`. Expected: the transfer assertion reddens. If it does not, the test is checking the buffer rather than the handoff.
2. Reply to `encode` with the id of the last `init`. Expected: the id test reddens.
3. Remove the uninitialised guard. Expected: test 3 reddens with something other than a `failed` reply — report what actually happens, since `encodeNode` receiving `undefined` may throw somewhere unhelpful.
4. Make `init` store the definition before probing it. Expected: test 2 still replies `failed`, but a following `encode` now succeeds where it should not — add that assertion if it is missing.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(worker): define the realm protocol and its handler"
```

---

### Task 3: A real Worker, and the hook that makes one possible

**Files:**
- Create: `tests/worker-hook.mjs`, `tests/worker-resolve-ts.mjs`, `tests/worker-entry-node.ts`, `tests/worker-port-node.ts`
- Test: extend `tests/worker-entry.test.ts` with a real-Worker block

**Interfaces:**
- Produces: `createNodeWorkerPort(): WorkerPort` for Tasks 4 and 5, and the bootstrap the Worker runs.

This is the task that makes every other one worth trusting. A fake port proves the pool's bookkeeping and nothing about structured clone, transferable neutering, or WASM in a second realm.

**Measured before this plan was written, and to be reproduced here:** a real `node:worker_threads` Worker ran the pipeline end to end and returned a 2024-byte buffer whose first four bytes are `pnts`, with the sender's buffer left at `byteLength` 0. Node's native type stripping does **not** rewrite a `.js` specifier to `.ts`, so without the hook this fails with `ERR_MODULE_NOT_FOUND` on `src/worker/pipeline.js`.

- [ ] **Step 1: Write the hook**

`tests/worker-resolve-ts.mjs` — plain JavaScript, because it runs before anything strips types:

```js
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolves this repository's `.js` specifiers to the `.ts` files they mean.
 *
 * `src/` uses `.js` specifiers because NodeNext requires them, and Node's
 * native type stripping does not rewrite them, so a Worker started on a
 * source file fails with ERR_MODULE_NOT_FOUND. This is test-only scaffolding:
 * production loads the Rollup bundle OVERVIEW §5 calls for.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier, context.parentURL);
      asTs.pathname = asTs.pathname.replace(/\.js$/, '.ts');
      if (existsSync(fileURLToPath(asTs))) {
        return next(asTs.href, context);
      }
    }
    throw error;
  }
}
```

`tests/worker-hook.mjs`:

```js
import { register } from 'node:module';

register('./worker-resolve-ts.mjs', import.meta.url);
```

- [ ] **Step 2: Write the bootstrap and the port**

`tests/worker-entry-node.ts` — the platform wiring Task 2 kept out of `entry.ts`:

```ts
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
```

`tests/worker-port-node.ts` implements `WorkerPort` from `../src/worker/protocol.js` (Task 2) over `node:worker_threads.Worker`, passing `execArgv: ['--import', <worker-hook.mjs url>]`.

- [ ] **Step 3: Write the failing tests**

1. A round trip through a real Worker returns a buffer whose first four bytes are `pnts`, **byte-identical** to what `encodePnts` produces for the same chunk on the main thread. Compare the whole buffer, not just its length: a length check passes against a buffer of zeros.
2. The submitted `compressed` buffer has `byteLength === 0` after posting, and the returned buffer has a non-zero `byteLength` on arrival.
3. A `ZeroPointChunkError` raised inside the Worker arrives through `fromWire` as a `ZeroPointChunkError` with its code intact.

**Give this file a generous timeout.** WASM initialisation in a fresh Worker is not instant; measure a run and set the timeout from what you see, recording the number in your report.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Drop `execArgv` from the port. Expected: the Worker errors with `ERR_MODULE_NOT_FOUND`; confirm the test reports it rather than hanging until the timeout. If it hangs, the port is not forwarding `error` events and Task 4 will inherit that.
2. Post the buffer without transferring it. Expected: test 2's neutering assertion reddens.
3. Compare only `byteLength` instead of the bytes in test 1, then have the Worker return a zeroed buffer of the right length. Expected: the weakened test passes — which is why it compares bytes. Restore both.

- [ ] **Step 6: Commit**

```bash
git commit -m "test(worker): drive the pipeline through a real Worker"
```

---

### Task 4: The pool — admission and dispatch

**Files:**
- Create: `src/worker/pool.ts`
- Test: `tests/worker-pool.test.ts`

**Interfaces:**
- Consumes: `Budget` and `Lease` from `src/budget/index.js`; `ToWorker`/`FromWorker` from `./protocol.js`; `fromWire` from `../errors/index.js`.
- Produces:

`WorkerPort` comes from `./protocol.js` (Task 2) and is re-exported here for callers.

```ts
export interface EncodeRequest {
  readonly compressed: ArrayBuffer;
  readonly header: DecodeHeader;
  readonly pointCount: number;
}

export type EncodeVerdict =
  | { readonly verdict: 'admitted'; readonly pnts: Promise<ArrayBuffer> }
  | { readonly verdict: 'deferred' }
  | { readonly verdict: 'rejected'; readonly reason: RejectionReason };

export interface WorkerPoolOptions {
  readonly spawn: () => WorkerPort;
  readonly definition: string;
  readonly budget: Budget;
  readonly size?: number;
}

export interface WorkerPool {
  encode(request: EncodeRequest, signal?: AbortSignal): EncodeVerdict;
  destroy(): void;
}

export const DEFAULT_POOL_SIZE = 4;
```

`verdict` and `RejectionReason` are the budget's own, not a second vocabulary for the same three outcomes — this verdict *is* the budget's verdict with a promise attached.

The pool does not create a budget. `Budget` is provider-scoped and already tracks four resources; the concurrency limit is that provider's `BudgetLimits.decodeJobs` (OVERVIEW §7: pool size × 2). A second concurrency number here would put the same value in two places and §7 would govern only one.

- [ ] **Step 1: Write the failing tests**

Use a controllable fake port so timing is deterministic — Task 3 already covers the real one. The fake records posted messages and lets the test reply on demand.

1. `encode` on a pool with an idle port returns `{ verdict: 'admitted' }` and the promise resolves with the buffer the port replies with.
2. Ports are spawned lazily: a pool constructed with `size: 4` has spawned **zero** ports before the first `encode`, and exactly one after it.
3. Concurrently posted tasks never exceed `size`. Submit 8 with `decodeJobs: 8`, `size: 2`, reply to none, and assert exactly 2 `encode` messages were posted. Assert on posted `encode` messages specifically — counting all messages would count `init` too and pass for the wrong reason.
4. A task admitted while every port is busy waits, and is posted as soon as one replies.
5. When the budget defers, `encode` returns `{ verdict: 'deferred' }`, posts nothing, and **remembers nothing**: replying to an outstanding task must not cause the deferred request to be posted later. This is the property that separates "the budget is the queue" from "the pool has a queue it calls deferred".
6. When the budget rejects, `encode` returns `{ verdict: 'rejected' }` carrying the budget's own reason.
7. A `failed` reply rejects the promise with the rebuilt typed error — assert `instanceof` and `.code`, not just that it rejected.
8. `init` is sent once per port, before any `encode` to it, and a port is not given work until it replies `ready`.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

The shape, with the parts that are easy to get subtly wrong written out:

```ts
interface Task {
  readonly id: number;
  readonly request: EncodeRequest;
  readonly lease: Lease;
  readonly settle: (result: ArrayBuffer) => void;
  readonly fail: (error: Error) => void;
  abandoned: boolean;
}

interface Slot {
  readonly port: WorkerPort;
  ready: boolean;
  busy: Task | undefined;
}
```

`encode` in order: refuse if destroyed; `budget.acquireDecodeJob()`; on `deferred`/`rejected` return that verdict unchanged; on `admitted` build the task, register the abort listener, then `dispatch()`.

`dispatch()` takes the first waiting task and the first `ready && !busy` slot; if there is no such slot and `slots.length < size`, spawn one and send its `init`. A task waits — holding its lease — until a slot frees.

**Release the lease exactly once**, in one place: a `finish(task)` helper called from every terminal path. Do not sprinkle `lease.release()` through the handlers; the budget throws `LeaseAlreadyReleasedError` on a double release, which turns a bookkeeping slip into a loud failure, but only if there is one obvious place to look.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Dispatch without the `ready` check. Expected: test 8 reddens.
2. Spawn all `size` ports in the constructor. Expected: test 2 reddens.
3. Let `dispatch` post to a busy slot. Expected: test 3 reddens.
4. Have `deferred` push the request onto the waiting list. Expected: test 5 reddens. If it does not, test 5 is not actually checking that nothing was remembered.
5. Resolve the promise with the raw `FromWorker` message rather than its `pnts`. Expected: test 1 reddens.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(worker): admit decode work against the shared budget"
```

---

### Task 5: Cancellation, worker failure, and destroy

**Files:**
- Modify: `src/worker/pool.ts`
- Test: `tests/worker-pool-lifecycle.test.ts`

Decision 5: every reservation is returned exactly once whether it ends in success, failure, cancellation or destroy. This task is where that is earned.

- [ ] **Step 1: Write the failing tests**

1. Aborting a task that has **not** been posted removes it from the waiting set, settles it once, releases its lease, and never posts it.
2. Aborting a task that **has** been posted does not post a cancel message — assert no message beyond `init` and `encode` was ever sent — and when its `done` arrives later it is discarded rather than settling the promise a second time.
3. A lease is released on every terminal path. Table-drive it: success, `failed` reply, pre-post abort, post-abort with a late `done`, post-abort with a late `failed`, port error, `destroy()`. After each, `budget.stats()` shows no outstanding decode reservation.
4. A double release throws `LeaseAlreadyReleasedError`. Assert that the pool never causes one — the assertion is that no path throws it, and mutation 3 below is what proves the assertion can fail.
5. A port's `onError` fails only that port's task; the next `encode` spawns a fresh port and succeeds.
6. `destroy()` settles every outstanding promise exactly once, releases every lease, and calls `terminate()` on every port.
7. **The ordering the budget's own contract calls out:** `Budget.destroy()` frees outstanding reservations but still accepts a held lease's later `release()`, once. Destroy the *budget* between a task's admission and its reply, then let the reply arrive. The pool must not double-release. Write this one deliberately — it is the case a quiet test would miss.
8. An `encode` after `destroy()` returns `rejected` with the budget's `'destroyed'` reason.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Abort handling: if the task is waiting, drop it and finish; if it is posted, set `abandoned = true` and finish immediately — the lease is returned now, not when the stale reply lands, because the Worker's slot is what is still occupied, not the budget's. When the reply arrives, `finish` has already run, so the handler must check `abandoned` and return without settling.

Whatever you do, there must remain exactly one `lease.release()` call site.

- [ ] **Step 4: Run and check**

- [ ] **Step 5: Mutations**

1. Release the lease in the reply handler as well as in `finish`. Expected: `LeaseAlreadyReleasedError` surfaces in the abandonment test.
2. Skip the `abandoned` check in the `done` handler. Expected: test 2 reddens on a double settle.
3. Remove the release from the port-error path. Expected: test 3's port-error row reddens.
4. Have `destroy()` terminate ports without settling promises. Expected: test 6 reddens — confirm it fails rather than hanging; a promise that never settles is a test that times out, which is a worse failure to read.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(worker): return every decode lease exactly once"
```

---

### Task 6: The realm boundary, and the README

**Files:**
- Modify: `tests/worker-boundary.test.ts`, `src/worker/README.md`

- [ ] **Step 1: Write the failing assertions**

Add a describe over `importClosure('worker/entry.ts')`:

- It **must** contain `worker/pipeline.ts`, `worker/decode.ts` and `crs/transform.ts` — the positive half, without which the two exclusions below would pass on an empty result.
- It must **not** contain `crs/registry.ts`, `crs/resolve.ts` or `crs/index.ts`.
- It must **not** contain `worker/pool.ts`. A Worker that pulled the pool in would carry the main thread's half of the system into every Worker, and nothing else would notice.

- [ ] **Step 2: Run and check**

They should pass immediately if Tasks 2 and 4 kept the realms apart. That is not a reason to skip Step 3 — an assertion that has never failed is an assertion nobody has tested.

- [ ] **Step 3: Mutations**

1. Add `import { createWorkerPool } from './pool.js';` to `entry.ts` and use it. Expected: the pool exclusion reddens.
2. Add `import { resolveCrsDefinition } from '../crs/index.js';` to `entry.ts`. Expected: the registry exclusions redden.
3. Rename `entry.ts` temporarily. Expected: the walk throws rather than passing on nothing.

- [ ] **Step 4: Rewrite the README**

`src/worker/README.md` currently describes one realm. It now has two, and the file that says which is which is this one. Three parts, matching `src/range/README.md` and `src/crs/README.md`: what the module does, the realm split and why the naming is inverted from `src/crs/`, and the limits worth knowing. State that `entry.ts` needs a platform bootstrap and that no browser one exists yet.

**Check every sentence against the code and `grep` every symbol you name.**

- [ ] **Step 5: Commit**

```bash
git commit -m "test(worker): hold both realms apart at the Worker entry"
```

---

## Done when

- A real `node:worker_threads` Worker encodes the pinned chunk into bytes identical to the main thread's, with the input buffer neutered by the transfer.
- A typed error thrown in the Worker arrives on the main thread as its own class, with its code; a foreign throw arrives as `WorkerTaskFailedError`.
- No error code can be added under `src/errors/` without the wire map failing.
- Concurrent posted tasks never exceed the pool size; admitted-but-waiting tasks never exceed the decode budget.
- `deferred` remembers nothing.
- Every decode lease is released exactly once across success, failure, both cancellation shapes, port error, pool destroy, and budget destroy.
- No `cancel` message exists in the protocol.
- `entry.ts`'s import closure reaches neither the CRS registry nor `pool.ts`.
- `src/worker/README.md` says which file belongs to which realm.

## Self-review

**Spec coverage.** Every section of the design doc maps to a task: realm split → Tasks 2, 4, 6; protocol → Task 2; no cancel message → Tasks 2, 5; budget as queue → Task 4; errors → Task 1; the port → Tasks 3, 4; worker failure → Task 5; verification items 1–4 → Task 3, 5–10 → Tasks 4 and 5, 11 → Task 6, 12 → Task 1. The spec's *Risks* section names the absent caller; nothing here can close that, and no task pretends to.

**Type consistency.** `WorkerPort`, `EncodeRequest`, `EncodeVerdict`, `WorkerPoolOptions`, `WorkerPool` are declared once in Task 4 and referenced by name afterwards. `ToWorker`/`FromWorker` are declared in Task 2 and consumed in Tasks 3, 4, 5. `WireError`/`toWire`/`fromWire` are declared in Task 1 and consumed in Tasks 2 and 4. `DecodeHeader` comes from the existing `src/worker/index.ts`.

**Placeholder scan.** One draft of Task 2 named a helper that does not exist; it now shows the real `createTransformFromDefinition` call with the reason it discards its result. No other step describes work without showing it.
