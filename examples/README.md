# Live demo

**https://kunyoungparkk.github.io/COPCTilesetProvider/**

A COPC file streamed into CesiumJS in a browser, with no build step: one HTML
file, one module, an import map. Nothing here is bundled, transpiled, or
installed. The panel shows the only number the demo is really about — how many
Range requests it took and how many bytes that was — updated on every frame for
as long as the camera keeps asking for more.

## Running it locally

```sh
npx http-server examples -p 8000   # then open http://localhost:8000
```

Any static server will do **as long as it answers Range requests with `206`**.
Python's `http.server` does not — it ignores the `Range` header and returns the
whole file with `200`, which this library refuses by design (there is no
whole-file fallback). A server that silently does that is the first thing to
check when a local run fails and a deployed one works.

The dataset is fetched at deploy time and is not in this repository, so a local
run has no file to open and prints the library's own error saying so. Point
`FILE_URL` in `main.js` at a COPC URL of your own to see it work.

## Where the data comes from

Autzen streams from its own public bucket, cross-origin, with nothing copied or
re-hosted for this page. That bucket sends `Content-Range` — `curl` sees it —
but omits `Access-Control-Expose-Headers`, and `Content-Range` is not on the
CORS-safelisted response list, so JavaScript cannot read it. Decision 4 accepts
such a response on its status and the exact length of its body, which is what
lets the demo point straight at a file it does not own.

It used to be copied into the deployment instead, and that cost more than the
81 MB per deploy: the first load after each one failed, because Pages could not
answer a Range for an object its CDN had not cached yet, and only the second
visit worked.

## The style panel

The four radio buttons on the right set `provider.tileset.style` and do
nothing else. `Classification` is reachable from them because the worker
writes it into the PNTS batch table (OVERVIEW Decision 6), so Cesium's own
style language addresses it the way it would on any 3D Tiles content — the
filtering runs in the point cloud shader, not in this library, and no tile is
re-requested or re-decoded when the selection changes.

`Intensity` sits in the batch table beside it and is styleable the same way.
The panel leaves it out because a ramp that reads well needs this dataset's
actual intensity range, and that range is a property of the file rather than
of the format.

## Vertical datum

Autzen's Z is NAVD88 orthometric height, not ellipsoidal, so `main.js` passes
`geoidHeight: -23.333` to `fromUrl` — the geoid's separation from the WGS84
ellipsoid at Autzen's coordinates (44.0587, -123.0687), read from NOAA's NGS
geoid service. That number belongs to this one location: separation varies
across the globe, so a different dataset needs its own value looked up for its
own footprint, not this one copied over.

## Imagery and terrain

Both come from Cesium ion, and both need the `CESIUM_ION_TOKEN` repository
secret — `pages.yml` writes it into the page at deploy time, so the token is
never committed and rotating it costs a secret change rather than a commit. The
token needs `assets:read` and access to asset `3830182` (Google Maps 2D
Satellite); if it restricts origins, the Pages URL has to be one of its allowed
URLs.

There is no fallback. Without a working token the globe comes up blank, which
is the same thing a local run gets, and a local run has no dataset to show over
it either. Cesium logs the refusal; the demo does not dress it up.

## Why it loads the published package

The import map points at `copc-tileset-provider` on a CDN, at a pinned version,
rather than at anything in this repository. That is deliberate, and it has a
cost worth knowing: **a feature that is merged but not published does not
appear here.** The demo will pass an option the published version has never
heard of and that version will drop it on the floor, silently.

It is worth the cost because this is the only place a defect that exists solely
in the distribution — a missing Worker bundle, a wrong `exports` map — shows up
in something a person looks at. `smoke/` judges the packed tarball before
publish; this judges what was actually published. Sharing code between them
would leave neither testing an artifact.

So: after publishing a release, bump the version in the import map.
