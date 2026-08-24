import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UnresolvableSpecifierError, findSpecifiers } from './import-closure.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// This module backs both tests/worker-boundary.test.ts and
// tests/crs-worker-boundary.test.ts, which assert a Worker-realm entry point
// cannot reach the CRS registry. That claim is only as good as this
// scanner's own comment/string/template awareness — a walker that mistook
// commented-out or quoted text for real code would either miss a genuine
// leak (false negative) or flag an innocent file (false positive), and
// either one would show up nowhere except here.
//
// Every behaviour below matters because a specific mutation was applied by
// hand to remove it from tests/import-closure.ts (drop comment handling,
// drop template-literal/concatenation refusal, drop string-skipping, drop
// interpolation brace-depth tracking, drop trivia-skipping between a keyword
// and its next token, drop the control-paren tracking that decides what a `/`
// after `)` means) and the exact `it` named in each mutation's own comment
// below reddened. An
// edge-case suite that stays green against a scanner with the edge cases
// removed would be worth nothing, so each one was checked to actually bite.
describe('findSpecifiers: comments and strings are invisible to the import/from search', () => {
  it('import.meta does not read as a call or a specifier', () => {
    // Mutation: change the `source[afterSpace] === '.'` branch in
    // handleImport from `return afterWord` to throw instead. Reddened this
    // test (unexpected throw) — confirming the branch is what keeps a
    // property access like `import.meta.url` from being mistaken for a call
    // whose argument needs resolving.
    const src = `
      export function f() {
        return import.meta.url;
      }
    `;
    expect(findSpecifiers(src, 'scratch.ts')).toEqual([]);
  });

  it('import( inside a line comment is never seen as code', () => {
    // Mutation: delete the `ch === '/' && next === '/'` branch in the main
    // loop. Reddened this test: with line comments no longer skipped, the
    // scanner walks into the commented-out text and throws on the template
    // literal argument it finds there.
    const src = `
      // await import(\`../crs/registry.js\`);
      export function f() { return 1; }
    `;
    expect(findSpecifiers(src, 'scratch.ts')).toEqual([]);
  });

  it('import( inside a block comment is never seen as code', () => {
    // Mutation: delete the `ch === '/' && next === '*'` branch in the main
    // loop. Reddened this test the same way as the line-comment case above.
    const src = `
      /* await import(\`../crs/registry.js\`); */
      export function f() { return 1; }
    `;
    expect(findSpecifiers(src, 'scratch.ts')).toEqual([]);
  });

  it('import( inside a string literal is never seen as code, and leaks no specifier', () => {
    // Mutation: delete the `ch === "'" || ch === '"'` branch in the main
    // loop (the generic top-level string skip — not the one inside
    // handleImport/handleFrom, which stays intact). Reddened this test: an
    // unrelated string is no longer consumed as one opaque token, so the
    // scanner walks into its characters and throws on the same text.
    const src = `
      const bogus = "text with import(\`../crs/registry.js\`) inside";
      export function f() { return bogus; }
    `;
    expect(findSpecifiers(src, 'scratch.ts')).toEqual([]);
  });
});

describe('findSpecifiers: static and literal-dynamic specifiers are still extracted', () => {
  it('a bare side-effect import is extracted, not refused', () => {
    // Mutation: delete the `source[afterSpace] === "'" || source[afterSpace]
    // === '"'` branch in handleImport (the bare-import case). Reddened this
    // test: with no branch to extract it, the specifier silently vanishes
    // (`[]` instead of the expected array) rather than being refused loudly
    // — a different failure shape than the others below, which is exactly
    // why this case needs its own assertion rather than reusing one of them.
    const src = "import '../crs/ecef.js';\nexport function f() { return 1; }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/ecef.js']);
  });

  it('a literal dynamic import is extracted, not refused', () => {
    // The other direction of G1's refusal path: a scanner that refuses every
    // dynamic import (not just unresolvable ones) would still pass every
    // "IS refused" test below. Mutation: force the dynamic-import branch in
    // handleImport to throw unconditionally, before checking whether the
    // argument is a quote. Reddened this test (unexpected throw) while
    // leaving both "IS refused" tests unaffected (they already expected a
    // throw) — which is the point: only this test can catch "refuses
    // everything."
    const src = "export async function f() { await import('../crs/ecef.js'); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/ecef.js']);
  });

  it('nested braces inside a template interpolation do not desync the scanner', () => {
    // Real shape from src/errors/crs.ts-style messages: a template literal
    // interpolation containing an object literal, i.e. its own nested `{`/
    // `}`. The specifier sits *after* that nested pair closes, still inside
    // the same interpolation — the position that only a depth-aware scanner
    // reaches as code.
    //
    // Mutation: remove the `braceDepth` counter entirely — make `{` a no-op
    // and make any `}` seen while inside an interpolation close it
    // immediately, depth or no depth. Reddened this test: the nested pair's
    // own `}` (from `{}`) is mistaken for the interpolation's own closing
    // brace, so the scanner falls back into "template literal text" mode one
    // brace early. From there, `import '../nested-marker.js';` is walked
    // character by character as inert template text (which only watches for
    // `\`, a backtick, or `${`) rather than scanned as code, so the specifier
    // it names is silently dropped — `['../crs/ecef.js']` instead of the
    // expected two-element array, not a throw. The real closing backtick is
    // still found correctly (there is only one left in the source), which is
    // exactly why this bug is silent rather than a crash.
    const src = `
      const label = \`\${ {}; import '../nested-marker.js'; }\`;
      import { y } from '../crs/ecef.js';
    `;
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../nested-marker.js', '../crs/ecef.js']);
  });
});

describe('findSpecifiers: refuses what it cannot resolve statically', () => {
  it('a template-literal dynamic import argument is refused', () => {
    // Mutation: change the final `throw new UnresolvableSpecifierError(...)`
    // in handleImport's dynamic-import branch (the "anything else" case) to
    // instead resume scanning without extracting a specifier. Reddened this
    // test: the call no longer throws at all.
    //
    // Asserted by type, not by matching the message against a regex: a
    // message regex would pass just as well for some unrelated `Error` that
    // happened to contain the same words, which is not what this test is
    // meant to pin down — the point is that this specific, typed refusal
    // fired, not merely that *something* threw.
    const src = 'export async function f() { await import(`../crs/registry.js`); }';
    expect(() => findSpecifiers(src, 'scratch.ts')).toThrow(UnresolvableSpecifierError);
  });

  it('a concatenated dynamic import argument is refused, not silently the first operand', () => {
    // Mutation: drop the `source[afterLiteral] === ')'` check after a
    // quoted argument (accept the first quoted literal unconditionally,
    // regardless of what follows it before the call's closing paren).
    // Reddened this test: `import('../crs/' + suffix)` no longer throws —
    // it would have silently resolved to `'../crs/'`, the wrong half of a
    // concatenation this scanner is told not to try to evaluate.
    const src = "export async function f(suffix) { await import('../crs/' + suffix); }";
    expect(() => findSpecifiers(src, 'scratch.ts')).toThrow(UnresolvableSpecifierError);
  });
});

describe('findSpecifiers: a comment between a keyword and its next token is trivia, not a wall', () => {
  it('a block comment between import and ( does not erase the dynamic import', () => {
    // Reproduced first, against the pre-fix scanner: `findSpecifiers`
    // returned `[]` here with no throw at all — handleImport's lookahead
    // (`skipWhitespace`) stopped in front of the comment, concluded "this
    // isn't a call", and returned to the main loop right at the comment,
    // which the main loop's own (correct) comment-skipping then consumed —
    // erasing any trace the dynamic import had ever been there. Mutation:
    // revert `skipTrivia` back to `skipWhitespace` in handleImport's
    // `afterSpace` line. Reddened this test (empty array instead of the
    // specifier) — the same silent-loss shape `UnresolvableSpecifierError`'s
    // own doc comment names as the failure this file exists to avoid.
    const src = "async function f() { await import/* c */('../crs/registry.js'); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a line comment between import and ( does not erase the dynamic import', () => {
    // Mutation: same as above. Reddened the same way — confirms the gap
    // isn't specific to block comments.
    const src = 'async function f() { await import // c\n(\'../crs/registry.js\'); }';
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a comment between import( and the specifier does not refuse the import', () => {
    // A different lookahead from the two above: `handleImport`'s own
    // `skipTrivia(afterSpace + 1)`, between the call's `(` and its
    // argument. Mutation: revert that one call to `skipWhitespace`.
    // Reddened this test — the argument no longer starts with a quote, so
    // the scanner takes the "anything else" path and refuses a perfectly
    // resolvable literal.
    const src = "async function f() { await import(/* c */'../crs/registry.js'); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a comment between the specifier and ) does not refuse the import', () => {
    // The fourth lookahead: `handleImport`'s `skipTrivia(end)`, between the
    // closing quote and the call's `)`. Mutation: revert that one call to
    // `skipWhitespace`. Reddened this test — the character after the
    // literal is `/`, not `)`, so the scanner reads a concatenation that
    // is not there and refuses.
    const src = "async function f() { await import('../crs/registry.js'/* c */); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('the same gap exists for from, and is closed the same way', () => {
    // Mutation: revert `skipTrivia` back to `skipWhitespace` in handleFrom's
    // `afterSpace` line (not handleImport's — this test alone reddens,
    // confirming the two lookaheads are independent, not one shared fix).
    const src = "import { x } from/* c */'../crs/ecef.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/ecef.js']);
  });
});

describe('findSpecifiers: a bare / is division or a regex literal, never a stray string delimiter', () => {
  it('a regex literal containing a quote no longer desyncs the string tracker', () => {
    // Reproduced first, against the pre-fix scanner: this threw
    // `Error: ...: unterminated string literal starting at index 66` — the
    // `'` inside `/'/ ` was read as opening a real string, and scanQuoted
    // then searched the rest of the file for a closing `'` that was never
    // going to mean what it found. This shape is not hypothetical:
    // `src/crs/epsg-codes.ts` carries a regex literal with the same
    // problem (`/^\s*"?EPSG"?\s*,\s*"?(\d+)"?\s*$/`, four double quotes) —
    // checked directly, that file has no imports of its own and is not
    // currently reachable from either boundary walk, so nothing was actually
    // saved by luck before this fix; the point is that nothing here would
    // have stopped a *reachable* file with an odd quote count in a regex
    // from throwing, or an even count from silently costing it an import —
    // neither is acceptable to leave open in a general-purpose scanner.
    const src = "const r = /'/; import { y } from '../crs/registry.js'; const s = '';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('division right after a parenthesized expression is division', () => {
    // The common, real shape (arithmetic on a parenthesized sub-expression,
    // e.g. `src/crs/ecef.ts`'s `(degrees * Math.PI) / 180`). Mutation: make
    // `isControlParen` return `true` unconditionally. Reddened this test
    // (and, being the broader mutation, the `obj.if` test below that the
    // narrower mutation there isolates): the `)` then reads as a closed
    // condition, this ordinary division gets misread as a regex-open, and
    // the `'` two tokens later inside `'../crs/registry.js'` desyncs the
    // tracker into an unhandled `unterminated string literal`.
    const src = 'const total = (a + b) / c; import { z } from \'../crs/registry.js\';';
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a regex literal right after an if (...) condition is a regex literal', () => {
    // The other side of the same decision, and the reason it is a decision
    // rather than a guess. Reproduced first, against a scanner that took
    // `)` to mean division unconditionally: this exact source returned `[]`
    // — no throw, the specifier silently gone, because the two misread
    // regex literals bracketing it each contributed one `'` and so left the
    // quote parity intact. That is the single failure mode this module may
    // not have, so the ambiguity was removed instead of re-guessed: see
    // `looksLikeDivision`.
    //
    // Mutation: make `isControlParen` return `false` unconditionally (the
    // old unconditional-division behaviour). Reddened this test — back to
    // `[]` instead of the expected specifier.
    const src = "if (x) /'/.test(y); import { a } from '../crs/registry.js'; if (z) /'/.test(w);";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a call to a method named like a keyword is a call, not a condition', () => {
    // `obj.if(x)` is a legal property access; only the bare keyword opens a
    // condition. Mutation: delete the trailing `.`-guard in
    // `isControlParen` (return `true` as soon as the word matches).
    // Reddened this test: `/ 2; import ... '` is then misread as a regex
    // literal and the tracker desyncs into `unterminated string literal`.
    const src = "const v = obj.if(x) / 2; import { z } from '../crs/registry.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a ) that closed no ( is refused rather than guessed', () => {
    // The one case the paren tracking cannot decide. It only arises from
    // malformed source (or from a desync that already happened), and the
    // cardinal property here is worth a loud failure: guessing either way
    // would put a silent miss back on the table. Mutation: replace the
    // `throw` in `looksLikeDivision`'s `)` branch with `return true`.
    // Reddened this test (no throw at all).
    const src = "const v = a) / 2; import { z } from '../crs/registry.js';";
    expect(() => findSpecifiers(src, 'scratch.ts')).toThrow(/cannot tell division from a regex/);
  });

  it('the ) of a dynamic import() is a call paren, not an undecidable one', () => {
    // `handleImport` consumes the call's `(` and `)` itself, so the main
    // loop never pushes or pops them — which would leave a following `/`
    // with a `)` behind it and nothing on the paren stack to judge it by.
    // Mutation: delete the `lastClosedParenWasControl = false` assignment in
    // `handleImport`'s literal-argument branch. Reddened this test: the
    // division after the call becomes undecidable and throws `cannot tell
    // division from a regex literal`, on source that is perfectly ordinary.
    const src = "const v = await import('../crs/ecef.js') / 2; import { z } from '../a.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/ecef.js', '../a.js']);
  });

  it('an unescaped / inside a regex character class does not close the literal', () => {
    // Mutation: delete the `[` and `]` branches in `scanRegexLiteral`, so
    // `inClass` is never set. Reddened this test: the `/` inside `[/']`
    // closes the literal early and the `'` right after it is read as
    // opening a string, which desyncs the tracker into `unterminated string
    // literal`. Measured, not derived — a first draft of this comment
    // predicted a silent `[]`; whether a desync surfaces as a throw or as a
    // silent miss depends only on how many quotes happen to follow, which
    // is why the assertion is on the returned list either way.
    const src = "const r = /[/']/; import { y } from '../crs/registry.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('an escaped / inside a regex does not close the literal', () => {
    // Mutation: delete the `ch === '\\'` branch in `scanRegexLiteral`.
    // Reddened this test the same way as the character-class case above:
    // the escaped `/` closes the literal early and the `'` behind it
    // desyncs the string tracker into `unterminated string literal`.
    const src = "const r = /a\\/'/; import { y } from '../crs/registry.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a ${ interpolation starts a fresh expression, so a / in it can open a regex', () => {
    // `${...}` is always a new expression, whatever preceded the template
    // literal. Mutation: delete the `lastSignificantChar = undefined` reset
    // on entering `${`. Reddened this test: the tag name `foo` is still the
    // last significant character, so the `/` reads as division-after-an-
    // identifier, the `'` inside the intended regex opens a string, and the
    // tracker desyncs into `unterminated string literal`.
    const src = "foo`${/'/}`; import { y } from '../crs/registry.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });
});

describe('findSpecifiers: an identifier before / can still be a value-expecting keyword', () => {
  it('return /re/ is a regex literal in statement position', () => {
    // Reproduced first, against the pre-fix scanner: this returned `[]` —
    // the exact same shape as the `)`-ambiguity above, one word earlier.
    // The two misread regex literals each contribute one `'`, so quote
    // parity survives and the specifier between them vanishes with no
    // throw. Mutation: remove `'return'` from `VALUE_EXPECTING_KEYWORDS`.
    // Reddened this test.
    const src =
      "function f(y){ return /'/.test(y); }\n" +
      "import { a } from '../crs/registry.js';\n" +
      "function g(y){ return /'/.test(y); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('else /re/ is a regex literal in statement position', () => {
    // Same shape as `return`, one keyword over. Mutation: remove `'else'`
    // from `VALUE_EXPECTING_KEYWORDS`. Reddened this test.
    const src =
      "function f(y){ if (y) { return 1; } else /'/.test(y); }\n" +
      "import { a } from '../crs/registry.js';\n" +
      "function g(y){ if (y) { return 1; } else /'/.test(y); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('typeof /re/ is a regex literal in statement position', () => {
    // Same shape again. Mutation: remove `'typeof'` from
    // `VALUE_EXPECTING_KEYWORDS`. Reddened this test.
    const src =
      "function f(y){ return typeof /'/.test(y); }\n" +
      "import { a } from '../crs/registry.js';\n" +
      "function g(y){ return typeof /'/.test(y); }";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  // The rest of the list the review named or asked to be considered
  // (`throw`, `void`, `delete`, `in`, `of`, `instanceof`, `new`, `do`,
  // `yield`, `await`, `case`), each in a context where it is the last word
  // before the `/`. One row per keyword so a mutation removing any single
  // entry from `VALUE_EXPECTING_KEYWORDS` reddens exactly that row, not the
  // whole table.
  const remaining: Array<[string, string]> = [
    ['throw', 'function f(y){ throw /\'/.test(y); }'],
    ['void', 'function f(y){ void /\'/.test(y); }'],
    ['delete', 'function f(y){ delete /\'/.test(y); }'],
    ['in', "function f(y){ return 'k' in /'/.test(y); }"],
    ['of', 'function f(y){ for (const x of /\'/.test(y)) { x; } }'],
    ['instanceof', 'function f(y){ return y instanceof /\'/.test(y); }'],
    ['new', 'function f(y){ return new /\'/.test(y); }'],
    ['do', 'function f(y){ do /\'/.test(y); while (y); }'],
    ['yield', 'function* f(y){ yield /\'/.test(y); }'],
    ['await', 'async function f(y){ await /\'/.test(y); }'],
    ['case', 'function f(y){ switch (y) { case /\'/.test(y): break; } }'],
  ];

  it.each(remaining)('%s /re/ is a regex literal, not division', (_keyword, snippet) => {
    const src = `${snippet}\nimport { a } from '../crs/registry.js';\n${snippet}`;
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });

  it('a property named like a keyword is still a member access', () => {
    // `src/budget/lease.ts` calls `active.delete(record)`, but a *call*
    // like that never reaches `isValueExpectingKeyword` at all: its `)`
    // is judged by the pre-existing `parenIsControl` stack (`delete(x)` is
    // not `if`/`while`/`for`/`with`, so that `)` already reads as ending a
    // value — division — with no help from the keyword list. The guard
    // only matters for a *bare* property access with no call following,
    // where the word itself is the last significant character before `/`.
    // Mutation: delete the trailing `.`-guard in `isValueExpectingKeyword`
    // (return `true` unconditionally once the word matches, mirroring the
    // equivalent mutation already applied to `isControlParen` above).
    // Reddened this test: `state.new / 2` misreads the division as a
    // regex-open, and the `'` inside `'../crs/registry.js'` desyncs the
    // tracker into `unterminated string literal`.
    const src = "const half = state.new / 2; import { z } from '../crs/registry.js';";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });
});

describe('findSpecifiers: a method literally named import is a call, not a dynamic import', () => {
  it('registry.import(...) is a member access, not import(...)', () => {
    // Reproduced first, against the pre-fix scanner:
    // `registry.import('../crs/registry.js')` returned
    // `['../crs/registry.js']` — a false positive (the opposite direction
    // from every other case in this file: a specifier appears that no real
    // `import`/`from` statement named), because `matchesWord('import', i)`
    // only ruled out `import` being the middle of a longer identifier, the
    // same gap `isControlParen`'s own `.`-guard already closes for
    // `if`/`while`/`for`/`with`. Mutation: delete the `!precededByDot(i)`
    // conjunct at the `matchesWord('import', i)` call site. Reddened this
    // test (an extra, wrong specifier in the array).
    const src = "const r = registry.import('../crs/registry.js');";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual([]);
  });

  it('optional-chained ?.import(...) is the same member access', () => {
    const src = "const r = registry?.import('../crs/registry.js');";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual([]);
  });

  it('a genuine dynamic import right after a member access is still read', () => {
    // Guards against an overcorrection: the `.`-guard must look at what
    // precedes `import` itself, not merely "is there a `.` anywhere on this
    // line" — a real `import(...)` following unrelated member-access code
    // must still be extracted.
    const src = "obj.prop; import('../crs/registry.js');";
    expect(findSpecifiers(src, 'scratch.ts')).toEqual(['../crs/registry.js']);
  });
});

describe('findSpecifiers: pinned against the real src/ tree, not restated in prose', () => {
  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...listTsFiles(full));
      } else if (extname(full) === '.ts') {
        out.push(full);
      }
    }
    return out;
  }

  // Every relative specifier a naive, non-lexing scan can find by looking
  // for `from '...'` / `from "..."` and a bare `import '...'` at the start
  // of a statement. This is not a general-purpose alternative parser (it
  // would happily match inside a comment or a string) — it is a cheap,
  // independent lower bound: `findSpecifiers` must never return fewer
  // specifiers than this naive count finds in a real file, because a real
  // file's specifiers are never disguised behind the ambiguities this file
  // exercises above. `src/` has no dynamic `import(...)` calls today
  // (checked directly), so this bound does not need to cover that case.
  function naiveSpecifiers(source: string): Set<string> {
    const specifiers = new Set<string>();
    for (const match of source.matchAll(/\bfrom\s*(['"])(\.[^'"]*)\1/g)) {
      specifiers.add(match[2] ?? '');
    }
    for (const match of source.matchAll(/^\s*import\s*(['"])(\.[^'"]*)\1/gm)) {
      specifiers.add(match[2] ?? '');
    }
    return specifiers;
  }

  it("every naively-found relative specifier in src/ is in findSpecifiers' result", () => {
    const files = listTsFiles(SRC);
    expect(files.length).toBeGreaterThan(0); // guards against a broken path silently checking nothing
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const actual = findSpecifiers(source, file);
      for (const specifier of naiveSpecifiers(source)) {
        expect(actual, `${file}: expected to find ${specifier}`).toContain(specifier);
      }
    }
  });
});
