# Publish smoke

Answers one question: **does the tarball `npm pack` produces actually work?**

```
npm run smoke
```

It packs, installs the tarball into a throwaway project alongside Cesium and
Vite, builds that project with Vite, and renders it in headless Chromium.
Nothing in it reads this repository's sources — the consumer app imports
`copc-tileset-provider` by name, exactly as a stranger would.

## What it judges

- **The tarball's contents.** Everything under `dist/`, nothing else. A missing
  `files` field would otherwise ship `docs/superpowers/` — this project's plans
  and specs — to every consumer.
- **The installed bundles.** The same assertions the build runs
  (`build/assert-bundles.mjs`), now against what actually installed: the Worker
  does not reach Cesium, the library carries no Node-only built-in, the wasm is
  present, and the library carries the Worker's text.
- **That a real bundler swallows the package.** Vite builds the consumer app;
  an `exports` map that names a path the tarball omits fails here.
- **That it renders with nothing supplied.** `fromUrl(url)` with no second
  argument: no `spawnWorker`, no `.wasm` served, no adapter written. 47 points,
  one tile, and more than zero lit pixels.
- **That those pixels are ours.** A negative control runs the same scene for
  the same 60 frames with no provider added and must light nothing. Without
  that zero the pixel count would be satisfied by anything the harness itself
  draws.

## What it does not judge

- **More than one browser.** Chromium under SwiftShader. Firefox and Safari
  module workers, and their CSP behaviour, are unmeasured.
- **A bundler that ignores `browser` fields.** Vite honours laz-perf's
  `"browser": "lib/web/index.js"`, so the Node build never comes up. A consumer
  toolchain that ignores that field would resolve it and fail on
  `require("fs")`.
- **A strict CSP.** The default Worker comes from a `blob:` URL. A `worker-src`
  policy that forbids `blob:` blocks it, and the way out is `spawnWorker` or
  `copc-tileset-provider/worker`.
- **A real-sized node.** 47 points is the smallest thing that can light a
  pixel. Nothing here says what 61,201 points cost.
- **Hierarchy page expansion.** The fixture fits in a single root page.

## Why it is not in CI

Step three installs from the network, and CI on this project never touches it
(CLAUDE.md). OVERVIEW §5 scopes this to once, immediately before publish. Its
absence from CI is the reason `npm test` stays a six-second offline loop.

## The fixture

`fixture.mjs` assembles a 2,719-byte single-tile COPC file out of the pinned
slices already in `fixtures/`: Autzen's header and VLRs, the real 951-byte LAZ
chunk for node 5-16-3-1, and a hand-encoded hierarchy page naming it. The
81 MB source file is never needed. `server.mjs` serves it over Range only — a
request without a `Range` header gets a 400, because Decision 4 forbids a
whole-file fallback and a server that offered one would hide a regression.
