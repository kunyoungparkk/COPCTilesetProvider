# Live demo

**https://kunyoungparkk.github.io/COPCTilesetProvider/**

A COPC file streamed into CesiumJS in a browser, with no build step: one HTML
file, one module, an import map. Nothing here is bundled, transpiled, or
installed.

## Running it locally

```sh
npx http-server examples -p 8000   # then open http://localhost:8000
```

Any static server will do **as long as it answers Range requests with `206`**.
Python's `http.server` does not — it ignores the `Range` header and returns the
whole file with `200`, which this library refuses by design (there is no
whole-file fallback). A server that silently does that is the first thing to
check when a local run fails and a deployed one works.

The default dataset is fetched at deploy time and is not in this repository,
so a local run needs a COPC URL of your own — paste one into the box. Any
static host works as long as it satisfies the two things
[the root README](../README.md#your-server-has-to-support-range-requests)
describes: `206` responses, and `Access-Control-Expose-Headers: Content-Range`
when the file is on another origin.

## Where the data comes from

Autzen is served from this same origin, next to the page, because its public
bucket does not expose `Content-Range` to browsers. It sends the header —
`curl` sees it — but omits `Access-Control-Expose-Headers`, and
`Content-Range` is not on the CORS-safelisted response list, so JavaScript
cannot read it. The library refuses rather than guessing, which is the right
call and also means that URL cannot drive a cross-origin demo.

`.github/workflows/pages.yml` downloads the file during deployment. It is
never committed.

That limitation is worth knowing rather than hiding: paste a URL from a host
with the same gap and the demo prints the library's own error, naming the
header the server has to add.

## Vertical datum

Autzen's Z is NAVD88 orthometric height, not ellipsoidal, so `main.js` passes
`geoidHeight: -23.333` to `fromUrl` — the geoid's separation from the WGS84
ellipsoid at Autzen's coordinates (44.0587, -123.0687), read from NOAA's NGS
geoid service. That number belongs to this one location: geoid separation
varies across the globe, so a different dataset needs its own value, looked
up for its own footprint, not this one copied over.

## Imagery

The globe's basemap comes from Cesium ion when the `CESIUM_ION_TOKEN`
repository secret is set — `.github/workflows/pages.yml` writes it into the
page at deploy time, so the token is never committed and rotating it costs a
secret change rather than a commit. The token needs `assets:read` and access to
asset `3830182` (Google Maps 2D Satellite); if it restricts origins, the Pages
URL has to be one of its allowed URLs. A token ion refuses looks exactly like no
token at all on the globe, so the page logs a console warning when that
happens.

Without it, and on every local run, the demo uses Natural Earth II from inside
Cesium's own CDN build: lower resolution, but it cannot be rate-limited or
withdrawn. Cesium's bundled default token is deliberately not used — it works,
but prints a banner across the page asking you not to rely on it.

## What the demo shows

- **`fromUrl(url, { geoidHeight })`, and nothing else.** No worker to
  construct, no wasm to serve, no adapter to write — the Worker is built from
  a bundle inlined into the library. `geoidHeight` is Autzen's own vertical
  offset (see [Vertical datum](#vertical-datum)), not required setup.
- **Errors are API.** The status bar prints the typed error's message
  verbatim. An unregistered coordinate system prints the `registerCrs(...)`
  call to paste.
- **Styling is Cesium's.** Both toggles are one `Cesium3DTileStyle`; nothing
  in this library participates.

The part that uses the library is a single block at the top of `main.js`,
above the line that separates it from the page wiring. It is about fifteen
lines, and that is the claim.

## Relationship to `smoke/`

None, on purpose. `smoke/` judges the packed tarball — it installs from a real
`npm pack` and renders in headless Chromium, which is the only way to catch a
defect that exists solely in the distribution. This demo loads the published
package from a CDN. Sharing code between them would mean the smoke stops
testing the artifact, so they stay separate.
