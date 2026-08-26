# Contributing

Thanks for looking. Issues and pull requests are welcome at
[the tracker](https://github.com/kunyoungparkk/COPCTilesetProvider/issues).

## Running things

Node **22.18.0 or newer** — `.nvmrc` pins it, so `nvm use` picks it up. That
floor is not a preference: three test files start a real `node:worker_threads`
Worker on a `.ts` entry point, and Node runs TypeScript without a flag only
from 22.18.0 (where [type stripping became the
default](https://nodejs.org/en/blog/release/v22.18.0), backported from 23.6).
On anything older those tests fail with `Unknown file extension ".ts"` while
the rest of the suite passes, which reads like a broken checkout rather than a
Node version.

```sh
npm install
npm test          # Vitest, offline, no build required
npm run typecheck # tsc --noEmit
npm run build     # rolldown + tsc → dist/, with the third-party notices
npm run notices   # regenerate THIRD-PARTY-NOTICES.md after a dependency bump
npm run smoke     # pack, install into a temp project, render in headless Chromium
```

The suite never touches the network. It reads pinned byte slices from
[`fixtures/`](fixtures/), which are cut from a real COPC file by
`node fixtures/cut.mjs` — run by hand, never by CI. `npm run smoke` is the
exception and installs from the registry, which is why it is a pre-publish
check rather than part of CI.

## Where the reasoning lives

- [`docs/architecture.md`](docs/architecture.md) — start here. How a frame
  becomes tiles, what each directory owns, and the three import boundaries the
  suite enforces.
- [`OVERVIEW.md`](OVERVIEW.md) — the design decisions and why each was made.
  Written in Korean: it is this project's planning language, and its six
  numbered decisions are binding on new work. If you are proposing something
  that contradicts one, say so in the issue first.
- [`CLAUDE.md`](CLAUDE.md) — repository conventions: commit format, branch
  naming, the standard every merged line is held to.
- A `README.md` in each directory under `src/`, explaining what that directory
  owns and what it deliberately does not.
- [`src/cesium-runtime/gate-findings.md`](src/cesium-runtime/gate-findings.md) —
  what a real browser render measured about the Cesium integration, including
  the things offline tests could not have caught.

## What review looks for

The bar is that a stranger can follow the code without its author present.
Comments explain *why*, never *what*, and they have to be true of the code as
it stands — a comment left describing behaviour a change removed is treated as
a defect, not a nit. Tests are expected to fail when the thing they cover
breaks; the way to know is to break it and watch.

## Releasing

1. Bump `version` in `package.json` and add the release's section to
   [`CHANGELOG.md`](CHANGELOG.md).
2. Bump the pinned version in `examples/index.html`'s import map. The demo
   loads the *published* package, so a release that skips this leaves it
   running the previous version — `tests/manifest.test.ts` fails until both
   agree.
3. `npm run notices` if any dependency moved.
4. `npm run smoke` — the one check that judges the packed tarball rather than
   the source tree.
5. Commit, then push a `v<version>` tag.
   [`.github/workflows/release.yml`](.github/workflows/release.yml) takes it
   from there: typecheck, test, build, `npm publish`, and a GitHub Release. It
   refuses a tag that disagrees with the manifest.

Nothing in that workflow holds an npm credential. The registry trusts this
repository's `release.yml` by name and accepts a short-lived OIDC assertion
instead — npm's trusted publishing, which replaced the automation tokens it
withdrew after the May 2026 account compromises. Two consequences worth
knowing before you touch either end: **renaming this workflow file revokes the
trust**, because the trusted publisher entry pins it by filename, and
provenance is attached automatically, so `--provenance` is not passed and must
not be re-added.

0.1.0 through 0.3.0 were published by hand and carry no provenance
attestation. 0.3.0 in particular was the first tag this workflow ever saw, and
it failed at publish because the secret it wanted then had never existed.
