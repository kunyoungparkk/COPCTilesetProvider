# CLAUDE.md

@OVERVIEW.md

The imported OVERVIEW.md (Korean) is the project constitution. Decisions 1–6
(§3) are binding — do not work around them. Tuning knobs (§7) have initial
values; change them only with measurements, and update the table when you do.
Ask before changing the public API surface.

## Engineering principles

Adapted from Andrej Karpathy's observations on agentic-coding failure modes,
as distilled in forrestchang/andrej-karpathy-skills. Bias toward caution over
speed; use judgment on trivial tasks.

1. **Think before coding.** State assumptions explicitly before implementing.
   If multiple interpretations exist, present them instead of picking one
   silently. If something is unclear or a simpler approach exists, stop and
   say so — surface confusion and tradeoffs rather than running past them.
2. **Simplicity first.** Write the minimum code that solves the problem.
   No features beyond what was asked, no abstractions for single-use code,
   no speculative flexibility, no error handling for impossible cases.
   If a senior engineer would call it overcomplicated, rewrite it.
3. **Surgical changes.** Touch only what the task requires. Don't improve,
   reformat, or refactor adjacent code; match existing style. Clean up
   orphans your own change created — nothing else. Every changed line
   should trace to the request.
4. **Goal-driven execution.** Turn tasks into verifiable goals with explicit
   success criteria ("fix the bug" → "write a test that reproduces it, then
   make it pass"), state a short plan with a check per step, and loop until
   verified.

## Open-source standard

This is a production library for real users, built to be maintained long-term.
Every artifact must be reviewable and continuable by a stranger:

- Code a reviewer can follow without the author present. Comments explain
  *why*, not *what*. No clever one-liners where a plain version exists.
- Public API surfaces have doc comments; non-obvious design choices link
  back to the relevant OVERVIEW decision (e.g. `// Decision 4: no 200 fallback`).
- The maintainer must be able to explain every merged line. Code that can't
  be explained doesn't get merged — simplify or reject.

## Language

- English: code, comments, commit messages, error messages, README, API docs.
- Korean: OVERVIEW.md and internal planning documents. Do not translate them.
- Error messages are part of the API (OVERVIEW §3, Decision 6): include the
  extracted EPSG code and a copy-paste-ready `registerCrs` call.

## Conventions

- Commits: `type(scope): summary` (feat, fix, test, docs, chore, refactor).
  English, imperative mood, under 72 chars. One commit = one purpose; the
  body explains *why* and cites the relevant OVERVIEW decision when one applies.
- Branches: task-scoped, named `type/topic` (commit types plus `gate/` for
  go/no-go experiments). One branch = one PR = one purpose; squash-merge to
  keep `main` linear, then push `main` immediately — a squash-merge left
  unpushed leaves the shared history behind the local one. Never force-push
  `main`; on branches prefer `--force-with-lease`; rebase only unpushed commits.
- Tests use pinned fixtures under `fixtures/`; CI never touches the network.

## Commands

- `npm run typecheck` — `tsc --noEmit` across `src/`, `tests/`, and the Vitest config.
- `npm test` — one Vitest run, exactly as CI invokes it.
- `npm run test:watch` — the same suite in watch mode.

Deliberately absent from `package.json` until the tooling behind them exists,
so the manifest never advertises a script that does not run: `npm run build`
(Rollup library + self-contained Worker bundle), `npm run dev` (Vite demo),
and `npm run serve:range` (local observable Range server for fixtures).