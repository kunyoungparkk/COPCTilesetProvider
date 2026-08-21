import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Thrown when the scanner meets a dynamic `import(...)` call whose argument
 * is not a single quoted string literal on its own — a template literal, a
 * bare identifier, a concatenation, or anything else JavaScript would have
 * to evaluate at run time to find out what it names.
 *
 * A specifier like that cannot be followed statically, and pretending
 * otherwise is how a walker starts lying: `tests/worker-boundary.test.ts`
 * and `tests/crs-worker-boundary.test.ts` exist to assert that a Worker-realm
 * entry point cannot reach the CRS registry, and a specifier this scanner
 * silently skipped would let that reach happen while the test stayed green.
 * Measured against this file's own predecessor (a plain regex): adding
 * `await import(\`../crs/registry.js\`)` inside `src/worker/pipeline.ts` made
 * the regex-based walker skip the specifier entirely, so the "cannot reach
 * the registry" assertion passed while the module genuinely imported it at
 * run time. Failing loudly here is what keeps that from happening quietly
 * again.
 */
export class UnresolvableSpecifierError extends Error {
  constructor(file: string, snippet: string) {
    super(`${file}: dynamic import() argument is not a quoted string literal: ${snippet}`);
    this.name = 'UnresolvableSpecifierError';
  }
}

const isIdentifierChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/**
 * Every module specifier `source` reaches statically (`import`/`export ...
 * from '...'`, a bare `import '...'`) or through a literal
 * `import('...')`/`import("...")` call — relative specifiers only (bare
 * package names like `node:fs` or `vitest` are not this walker's concern and
 * are silently dropped, the same way the regex this replaces only ever
 * captured a `.`-prefixed group).
 *
 * Comments and the interior of unrelated strings or template literals are
 * invisible to the `import`/`from` keyword search — not because their text
 * is erased, but because the scanner only ever looks for those keywords
 * while it is positioned in "code": never inside a `//` or `/* *\/` comment,
 * never inside a `'...'`/`"..."` string's characters, and never inside a
 * template literal's literal text (as opposed to one of its `${...}`
 * interpolations, which is code again and scanned as such, recursively,
 * since it can itself contain nested strings, comments, or templates). A
 * single regex pass has no notion of "where" it is in the file, which is
 * exactly the blind spot `UnresolvableSpecifierError`'s own doc comment
 * measured: it does not merely fail to resolve a dynamic specifier, it fails
 * to notice one is there at all.
 *
 * Throws `UnresolvableSpecifierError` on a dynamic `import(...)` whose
 * argument is not a bare quoted literal — never on a static `import`/`from`,
 * since ordinary JS grammar forces that specifier to be a string literal
 * already.
 */
export function findSpecifiers(source: string, file: string): string[] {
  const found: string[] = [];
  const length = source.length;

  // One entry per `${...}` interpolation the scanner is currently inside,
  // innermost last. `braceDepth` counts unmatched `{` seen since this
  // interpolation's own opening `${`, so the `}` that closes an object
  // literal or block *inside* the interpolation can be told apart from the
  // one that closes the interpolation itself back into template text.
  type Interpolation = { braceDepth: number };
  const interpolations: Interpolation[] = [];
  // Whether the scanner is currently inside a template literal's own literal
  // text (as opposed to top-level code or one of the interpolations above).
  // A stack because templates can nest inside their own interpolations
  // (`` `outer ${`inner`}` ``).
  const templateText: boolean[] = [];

  let i = 0;
  // The last non-trivia character consumed while in "code" mode (top level
  // or a `${...}` interpolation) — never a whitespace or comment character.
  // Used only to decide what a bare `/` means; see `looksLikeDivision` below.
  let lastSignificantChar: string | undefined;
  // One entry per `(` currently open in code mode, innermost last: whether
  // it was a control-structure paren (`if`/`while`/`for`/`with`).
  const parenIsControl: boolean[] = [];
  // What the most recently closed `)` was, or `undefined` if it closed no
  // `(` this scanner had seen. Read only when `lastSignificantChar` is `)`.
  let lastClosedParenWasControl: boolean | undefined;

  /** True at `index` only when `word` is not the middle of a longer identifier. */
  function matchesWord(word: string, index: number): boolean {
    if (source.slice(index, index + word.length) !== word) return false;
    return !isIdentifierChar(source[index - 1]) && !isIdentifierChar(source[index + word.length]);
  }

  /**
   * Whether the word starting at `index` is a property or method access —
   * a `.` (optional-chained or not) immediately before it, skipping only
   * whitespace. `isControlParen` already excludes `obj.if(x)` from reading
   * as a condition the same way; `handleImport`'s call to `matchesWord`
   * needs the identical guard, since `registry.import('../crs/registry.js')`
   * — a method literally named `import` taking one string argument — is
   * otherwise indistinguishable in shape from a dynamic `import(...)` call.
   * `from` needs no such guard: `Array.from(...)` is caught by `matchesWord`
   * the same as `.import`, but `handleFrom` only ever extracts a specifier
   * when a quote follows immediately, which a call's `(` never is.
   */
  function precededByDot(index: number): boolean {
    let j = index - 1;
    while (j >= 0 && isWhitespace(source[j])) j--;
    return source[j] === '.';
  }

  function skipWhitespace(index: number): number {
    let j = index;
    while (j < length && isWhitespace(source[j])) j++;
    return j;
  }

  /**
   * Like `skipWhitespace`, but also skips comments — the trivia a real JS
   * engine is blind to between two tokens. `handleImport` and `handleFrom`
   * both need to look past whatever separates the keyword from the token
   * that decides what it is (`(`, a quote, or a `.`); `skipWhitespace` alone
   * left a comment there invisible to *this* scanner too, but for the wrong
   * reason — not because it was correctly treated as trivia, but because the
   * lookahead simply stopped in front of it, so the keyword handler always
   * concluded "nothing here" and let the main loop's own comment-skipping
   * consume it afterwards, erasing any trace the keyword had ever mattered.
   * Measured: `import/* c *\/('../crs/registry.js')` and
   * `import // c\n('../crs/registry.js')` both returned `[]` — the dynamic
   * import vanished with no throw, the same silent loss
   * `UnresolvableSpecifierError`'s own doc comment names as the failure mode
   * this file exists to avoid. `from` had the identical gap, checked the
   * same way.
   */
  function skipTrivia(index: number): number {
    let j = skipWhitespace(index);
    while (true) {
      if (source[j] === '/' && source[j + 1] === '/') {
        const end = source.indexOf('\n', j);
        j = skipWhitespace(end === -1 ? length : end);
        continue;
      }
      if (source[j] === '/' && source[j + 1] === '*') {
        const end = source.indexOf('*/', j + 2);
        j = skipWhitespace(end === -1 ? length : end + 2);
        continue;
      }
      break;
    }
    return j;
  }

  /**
   * Reads a `'...'` or `"..."` string starting at `quoteIndex` (which must
   * hold the opening quote). Returns its content (escapes left as written —
   * a resolved specifier never needs unescaping, since a relative path has
   * no reason to contain one) and the index just past the closing quote.
   */
  function scanQuoted(quoteIndex: number): { content: string; end: number } {
    const quote = source[quoteIndex];
    let j = quoteIndex + 1;
    let content = '';
    while (j < length) {
      const ch = source[j];
      if (ch === '\\') {
        content += source.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (ch === quote) {
        return { content, end: j + 1 };
      }
      content += ch;
      j++;
    }
    throw new Error(`${file}: unterminated string literal starting at index ${quoteIndex}`);
  }

  /**
   * Whether the `(` at `index` is the paren of an `if`, `while`, `for`, or
   * `with` — i.e. opens a *condition* rather than a value expression, a call
   * argument list, or a parameter list.
   *
   * The look backwards skips whitespace only, not comments: `if /* c *\/ (x)`
   * reads as a non-control paren. Scanning comments backwards is a different
   * problem from scanning them forwards (a `*\/` can occur inside a string),
   * and nothing in this repository writes that shape.
   */
  function isControlParen(index: number): boolean {
    let j = index - 1;
    while (j >= 0 && isWhitespace(source[j])) j--;
    const wordEnd = j + 1;
    while (j >= 0 && isIdentifierChar(source[j])) j--;
    const word = source.slice(j + 1, wordEnd);
    if (word !== 'if' && word !== 'while' && word !== 'for' && word !== 'with') return false;
    // `obj.if(x)` / `a?.if(x)`: a property that happens to be named like the
    // keyword is still an ordinary call.
    while (j >= 0 && isWhitespace(source[j])) j--;
    return source[j] !== '.';
  }

  /**
   * Whether a `/` at `index` means division (or the start of `/=`), rather
   * than opening a regex literal. Real JS engines answer this from the
   * parser state (is a value expression expected here, or an operator?);
   * this file has no parser to ask — OVERVIEW §5 records that TS 7's
   * `typescript` package is a native-compiler wrapper with no JS compiler
   * API to build one against, and §5 forbids adding a dependency that would
   * supply one, so a hand-rolled decision is the only option left, not a
   * shortcut chosen over a better one.
   *
   * The standard heuristic (used by hand-rolled lexers generally, not
   * invented for this file): a `/` means division if the last significant
   * token could have ended a value — an identifier, a number, a closing
   * string/template/regex delimiter, or `]` — and means a regex literal
   * otherwise (after an operator, `(`, `,`, `;`, `{`, or at the very start).
   *
   * `)` is the one character that heuristic cannot decide on its own:
   * `(a + b) / c` is division and `if (x) /re/.test(y)` is a regex literal
   * in statement position, and both leave `)` as the last significant
   * character. Guessing either way is silently wrong in the other
   * direction, and silence is the one failure mode this scanner may not
   * have: measured with the guess fixed at division,
   * `if (x) /'/.test(y); import { a } from '../crs/registry.js'; if (z) /'/.test(w);`
   * returned `[]` — no throw, the specifier simply gone, because the two
   * misread regex literals contributed one `'` each and so cancelled the
   * quote parity around it. So the ambiguity is removed rather than
   * resolved: `parenIsControl` records for every open `(` whether
   * `isControlParen` judged it a condition. A `)` closing a condition is
   * followed by a *statement*, where `/` opens a regex; a `)` closing
   * anything else ends a *value*, where `/` divides.
   *
   * What that decides, and what it still gets wrong:
   * - Exact for `if`/`while`/`for`/`with` conditions, and for every other
   *   `)` — parenthesized expressions, call arguments, parameter lists.
   *   The legal-but-absurd `do {} while (x) /re/` and `for (;;) /re/` land
   *   on the correct side too, since both are conditions followed by
   *   statement position.
   * - Also exact for a statement position that leaves an *identifier*
   *   behind rather than `)`: `return /re/`, `else /re/`, and `typeof /re/`
   *   are the same ambiguity in a different disguise — two such misread
   *   regex literals cancel their quote parity exactly like the `)` case
   *   above, so `return /'/.test(y); import ... from '../crs/registry.js';
   *   return /'/.test(w);` measured as `[]`, no throw, before this was
   *   handled. `isValueExpectingKeyword` reads the whole word ending at
   *   `index` and checks it against a fixed list of keywords that are
   *   always followed by an expression, never an operand of one:
   *   `return`, `else`, `typeof`, `throw`, `void`, `delete`, `in`, `of`,
   *   `instanceof`, `new`, `do`, `yield`, `await`, `case`. `case 1: /re/`
   *   never needed this — the `:` before it already isn't a value-ending
   *   character.
   * - A `.` immediately before the word (skipping whitespace) makes it a
   *   property or method name, not the keyword — `state.new / 2` is
   *   ordinary division on a property literally named `new`, not the
   *   keyword. Same guard `isControlParen` already applies to `obj.if(x)`.
   * - Still wrong when one of these words is used as a plain identifier
   *   outside the position that makes it a keyword — `of` and `in` are not
   *   globally reserved, so `const of = x; of / 2;` misreads the division
   *   as a regex open. What that costs is bounded: `scanRegexLiteral` bails
   *   at a newline, so a misread `/` cannot reach past its own line, and a
   *   specifier is lost only when it sits on that same physical line — and
   *   then the scan throws rather than returning short. Nothing under `src/`
   *   does this; the whole-tree scan in `tests/import-closure.test.ts` is
   *   what backs that claim now, rather than this comment asserting it
   *   unpinned.
   * - A `)` that closed no `(` this scanner saw leaves nothing to decide
   *   from, so it throws rather than guessing.
   */
  const VALUE_EXPECTING_KEYWORDS = new Set([
    'return',
    'else',
    'typeof',
    'throw',
    'void',
    'delete',
    'in',
    'of',
    'instanceof',
    'new',
    'do',
    'yield',
    'await',
    'case',
  ]);

  /**
   * Whether the word ending at `index` (the position of a `/` under test)
   * is one of `VALUE_EXPECTING_KEYWORDS` and not itself a property or
   * method name (`state.new`) — see the guard note in `looksLikeDivision`'s
   * doc comment above. Mirrors `isControlParen`'s backward word-scan and
   * `.`-guard, applied to a different keyword set at a different call site
   * (a bare `/`, not a `(`).
   */
  function isValueExpectingKeyword(index: number): boolean {
    let j = index - 1;
    while (j >= 0 && isWhitespace(source[j])) j--;
    const wordEnd = j + 1;
    while (j >= 0 && isIdentifierChar(source[j])) j--;
    const word = source.slice(j + 1, wordEnd);
    if (!VALUE_EXPECTING_KEYWORDS.has(word)) return false;
    while (j >= 0 && isWhitespace(source[j])) j--;
    return source[j] !== '.';
  }

  function looksLikeDivision(index: number): boolean {
    if (lastSignificantChar === undefined) return false;
    if (lastSignificantChar === ')') {
      if (lastClosedParenWasControl === undefined) {
        throw new Error(
          `${file}: cannot tell division from a regex literal at index ${index}: ` +
            'the preceding `)` closed no `(` this scanner saw',
        );
      }
      return !lastClosedParenWasControl;
    }
    if (isIdentifierChar(lastSignificantChar)) {
      return !isValueExpectingKeyword(index);
    }
    return /[\]'"`]/.test(lastSignificantChar);
  }

  /**
   * Scans a regex literal starting at `index` (which must hold the opening
   * `/`), respecting backslash escapes and character classes — an unescaped
   * `/` inside `[...]` does not close the literal, the same as real JS
   * grammar. Trailing flags (`g`, `i`, ...) are consumed too, so the caller
   * resumes right after them.
   *
   * If no closing `/` is found before a raw newline or end of file, this
   * was not actually a regex literal — `looksLikeDivision` guessed wrong, or
   * this is a malformed file. Either way, nothing here can recover the
   * correct parse, so this function backs out and returns `index + 1`: just
   * the opening `/` is treated as an ordinary character, and scanning
   * resumes normally from right after it (rather than consuming the rest of
   * the file as one unterminated "regex").
   */
  function scanRegexLiteral(index: number): number {
    let j = index + 1;
    let inClass = false;
    let closed = false;
    while (j < length) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '\n') {
        break; // not closed — bail out below, this was not a regex literal
      }
      if (ch === '[') {
        inClass = true;
        j += 1;
        continue;
      }
      if (ch === ']') {
        inClass = false;
        j += 1;
        continue;
      }
      if (ch === '/' && !inClass) {
        j += 1;
        closed = true;
        break;
      }
      j += 1;
    }
    if (!closed) return index + 1;
    while (j < length && /[A-Za-z]/.test(source[j] ?? '')) j++;
    return j;
  }

  /**
   * A best-effort, human-readable snippet of a dynamic import's argument,
   * for the error message only — not required to be exact, since by the
   * time it is called the argument has already been judged unresolvable and
   * nothing downstream parses this snippet back.
   */
  function snippetFor(index: number): string {
    let depth = 0;
    let j = index;
    const cap = Math.min(length, index + 200);
    while (j < cap) {
      const ch = source[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    return source.slice(index, j).trim();
  }

  /** Handles a matched `import` keyword at `index`; returns the resume index. */
  function handleImport(index: number): number {
    const afterWord = index + 'import'.length;
    const afterSpace = skipTrivia(afterWord);

    if (source[afterSpace] === '.') {
      // `import.meta` (or `.meta.url`, etc.) — a property access, not a
      // call and not a specifier. Nothing to extract; resume right after
      // the keyword so the following `.` is scanned as ordinary code.
      return afterWord;
    }

    if (source[afterSpace] === '(') {
      const argStart = skipTrivia(afterSpace + 1);
      const ch = source[argStart];
      if (ch === "'" || ch === '"') {
        const { content, end } = scanQuoted(argStart);
        const afterLiteral = skipTrivia(end);
        if (source[afterLiteral] === ')') {
          if (content.startsWith('.')) found.push(content);
          // This branch consumes the call's `(` and `)` itself, so the main
          // loop never records them; a call paren is never a control paren.
          lastClosedParenWasControl = false;
          return afterLiteral + 1;
        }
        // A quote opens the argument but something follows before the call's
        // closing paren — e.g. `import('a' + suffix)`. Looks literal at a
        // glance; is actually a concatenation this scanner is told not to
        // try to resolve (brief's own ruling).
        throw new UnresolvableSpecifierError(file, snippetFor(argStart));
      }
      // Anything else — a template literal, an identifier, a nested call —
      // cannot be resolved without evaluating it.
      throw new UnresolvableSpecifierError(file, snippetFor(argStart));
    }

    if (source[afterSpace] === "'" || source[afterSpace] === '"') {
      // A bare side-effect import: `import '../foo.js';` — no `from`, no
      // parens, so nothing else will ever pick this specifier up.
      const { content, end } = scanQuoted(afterSpace);
      if (content.startsWith('.')) found.push(content);
      return end;
    }

    // `import Default from '...'` or `import { a, b } from '...'` — the
    // specifier is not here; the `from` keyword later in this same
    // statement carries it, and gets its own match on a later iteration.
    return afterWord;
  }

  /** Handles a matched `from` keyword at `index`; returns the resume index. */
  function handleFrom(index: number): number {
    const afterWord = index + 'from'.length;
    const afterSpace = skipTrivia(afterWord);
    if (source[afterSpace] === "'" || source[afterSpace] === '"') {
      const { content, end } = scanQuoted(afterSpace);
      if (content.startsWith('.')) found.push(content);
      return end;
    }
    // Not an import/export clause at all — `Array.from(...)`, or an
    // identifier literally named `from`. Nothing to extract.
    return afterWord;
  }

  while (i < length) {
    if (templateText[templateText.length - 1] === true) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        templateText.pop();
        i += 1;
        lastSignificantChar = '`'; // a completed template literal is a value
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        templateText.pop();
        templateText.push(false); // parent frame is "in code" while this interpolation is open
        interpolations.push({ braceDepth: 0 });
        i += 2;
        // `${...}` always opens a fresh expression, regardless of whatever
        // ended the text (or an enclosing expression) before this template
        // literal started — reset so a `/` right here is judged the same as
        // one at the very start of the file (regex-allowed), not against a
        // stale character from outside this template entirely.
        lastSignificantChar = undefined;
        continue;
      }
      i += 1;
      continue;
    }

    // Code mode: top level, or inside a `${...}` interpolation.
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = scanQuoted(i).end;
      lastSignificantChar = source[i - 1];
      continue;
    }
    if (ch === '`') {
      templateText.push(true);
      i += 1;
      continue;
    }
    if (ch === '/' && !looksLikeDivision(i)) {
      i = scanRegexLiteral(i);
      lastSignificantChar = source[i - 1];
      continue;
    }
    const topInterpolation = interpolations[interpolations.length - 1];
    if (ch === '{' && templateText.length > 0 && topInterpolation !== undefined) {
      topInterpolation.braceDepth++;
      i += 1;
      lastSignificantChar = ch;
      continue;
    }
    if (ch === '}' && templateText.length > 0 && topInterpolation !== undefined) {
      if (topInterpolation.braceDepth > 0) {
        topInterpolation.braceDepth--;
      } else {
        interpolations.pop();
        templateText[templateText.length - 1] = true; // back into the template's literal text
      }
      i += 1;
      lastSignificantChar = ch;
      continue;
    }
    if (ch === '(') {
      parenIsControl.push(isControlParen(i));
      i += 1;
      lastSignificantChar = ch;
      continue;
    }
    if (ch === ')') {
      // `undefined` when the stack is empty: an unmatched `)`, which
      // `looksLikeDivision` refuses to decide a following `/` from.
      lastClosedParenWasControl = parenIsControl.pop();
      i += 1;
      lastSignificantChar = ch;
      continue;
    }
    if (matchesWord('import', i) && !precededByDot(i)) {
      i = handleImport(i);
      lastSignificantChar = source[i - 1];
      continue;
    }
    if (matchesWord('from', i)) {
      i = handleFrom(i);
      lastSignificantChar = source[i - 1];
      continue;
    }
    if (!isWhitespace(ch)) lastSignificantChar = ch;
    i += 1;
  }

  return found;
}

/** Every module under `src/` that this entry point can reach, itself included. */
export function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);

    const source = readFileSync(resolve(SRC, file), 'utf8');
    for (const specifier of findSpecifiers(source, file)) {
      // Written as the `.js` the browser will fetch; read as the `.ts` on disk.
      const target = relative(SRC, resolve(dirname(resolve(SRC, file)), specifier))
        .replace(/\.js$/, '.ts');
      if (!target.startsWith('..')) {
        queue.push(target);
      }
    }
  }
  return [...seen];
}
