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

    // The class assertion belongs here rather than only in the test above:
    // WorkerTaskFailedError embeds the wrapped error's text verbatim, so a
    // fromWire broken to return it unconditionally still satisfies both
    // substring checks. Without this line the test cannot detect the bug it
    // sits next to.
    expect(rebuilt).toBeInstanceOf(MalformedHierarchyError);
    expect(rebuilt.message).toContain('https://host/a.copc.laz');
    expect(rebuilt.message).toContain('9-9-9-9');
  });

  // A rebuilt error has to be indistinguishable from one raised in this
  // realm, not merely equal on the fields callers read first: `message` and
  // `stack` are non-enumerable on a real Error, so assigning them plainly
  // would make JSON.stringify and Object.keys disagree between the two.
  it('serialises the same way an error raised in this realm does', () => {
    const original = new ZeroPointChunkError();

    const rebuilt = fromWire(cloned(toWire(original)));

    expect(Object.keys(rebuilt)).toEqual(Object.keys(original));
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(original));
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
    // Recursive: `src/errors/` is flat today, and a class added one directory
    // down would otherwise be invisible to the guard that exists to make
    // forgetting impossible.
    // The class name as well as the code, because presence is not the property
    // that matters: `fromWire` assigns `code` from the wire after choosing a
    // class, so a code mapped to the WRONG class rebuilds with the right code
    // and the wrong prototype — and a caller's `instanceof` silently stops
    // matching. Capturing both halves of each declaration is what lets this
    // check the association rather than the key set.
    const declared = readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => [
        ...readFileSync(`${directory}${name}`, 'utf8').matchAll(
          /export class (\w+) extends CopcTilesetError \{\s*readonly code = '([^']+)'/g,
        ),
      ])
      .map((match) => ({ className: match[1], code: match[2] }));

    // Guards the guard: a regex that stops matching would make this pass on
    // an empty set.
    expect(declared.length).toBeGreaterThan(15);

    for (const { className, code } of declared) {
      const rebuilt = fromWire({ code: code ?? '', name: 'X', message: 'm', stack: undefined });
      expect(rebuilt.code, `code ${code} is missing from the wire map`).toBe(code);
      expect(
        rebuilt.constructor.name,
        `code ${code} is mapped to the wrong class in the wire map`,
      ).toBe(className);
    }
  });
});
