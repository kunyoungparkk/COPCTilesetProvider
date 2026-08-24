# Contributing

Thanks for looking. Issues and pull requests are welcome at
[the tracker](https://github.com/kunyoungparkk/COPCTilesetProvider/issues).

## Running things

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
   from there: typecheck, test, build, `npm publish --provenance`, and a
   GitHub Release. It refuses a tag that disagrees with the manifest.
