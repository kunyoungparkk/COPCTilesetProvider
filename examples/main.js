import { COPCTilesetProvider } from 'copc-tileset-provider';

// Autzen, the classic LiDAR test scene, stored in EPSG:2992 (Oregon Statewide
// Lambert, international feet). Served from this same origin — see
// examples/README.md for why the demo does not stream it from its public
// bucket.
const DEFAULT_URL = new URL('./data/autzen-classified.copc.laz', location.href).href;

const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Geoid height at Autzen (44.0587, -123.0687), from NOAA's NGS geoid service.
// The value belongs to this dataset's location, not to the library.
const AUTZEN_GEOID_HEIGHT = -23.333;

// ---------------------------------------------------------------------------
// Using the library. This is the whole of it.
// ---------------------------------------------------------------------------

/**
 * Registers the file's coordinate system, opens it, and puts it on the globe.
 * Returns the provider so the caller can style it and, later, destroy it.
 */
async function showCopc(viewer, url) {
  COPCTilesetProvider.registerCrs(2992, OREGON);

  const provider = await COPCTilesetProvider.fromUrl(url, {
    // Autzen's Z is NAVD88 orthometric; NGS puts the geoid 23.333 m below the
    // ellipsoid here. Without this the points float that far over the terrain.
    geoidHeight: AUTZEN_GEOID_HEIGHT,
  });
  viewer.scene.primitives.add(provider);
  await viewer.flyTo(provider.tileset, {
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(30), Cesium.Math.toRadians(-32), 0),
  });

  return provider;
}

/** Everything the toggles do goes through Cesium's own style language. */
function applyStyle(provider, { ground, colorByClass }) {
  const style = {};
  // LAS classification 2 is bare earth.
  if (!ground) style.show = '${Classification} !== 2';
  if (colorByClass) {
    style.color =
      "${Classification} === 2 ? color('#8d6e63')" +
      " : ${Classification} === 5 ? color('#66bb6a')" +
      " : ${Classification} === 6 ? color('#ef5350')" +
      " : color('#b0bec5')";
  }
  provider.tileset.style = new Cesium.Cesium3DTileStyle(style);
}

// ---------------------------------------------------------------------------
// Page wiring. Nothing below is part of using the library.
// ---------------------------------------------------------------------------

const els = {
  url: document.getElementById('url'),
  load: document.getElementById('load'),
  ground: document.getElementById('ground'),
  colorByClass: document.getElementById('colorByClass'),
  status: document.getElementById('status'),
};

els.url.value = DEFAULT_URL;

function say(text, kind = '') {
  els.status.textContent = text;
  els.status.className = kind;
}

// Google Maps 2D Satellite. ion's own default is Bing Maps Aerial (asset 2);
// this one is picked for the close-in view the demo flies to. Reaching it needs
// a token carrying `assets:read`, and — if the token restricts origins — the
// deploy URL among its allowed URLs.
const ION_IMAGERY_ASSET_ID = 3830182;

// Set here rather than inside either function below, so neither depends on
// running before the other.
const ionToken = globalThis.CESIUM_ION_TOKEN;
if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

/**
 * Imagery for the globe, best-effort.
 *
 * ion's imagery is the only thing here sharp enough to recognise ground under
 * the points, and it needs a token. Without one — every local run, and any
 * deploy where the secret is missing — this uses Natural Earth II, which ships
 * inside Cesium's own CDN build and cannot fail or be rate-limited.
 *
 * Cesium's build carries a shared default token that would work without any of
 * this, but it prints a banner across the bottom of the page asking you not to
 * rely on it, and it is rate-limited globally. So the choice is ours or none.
 */
async function baseImagery() {
  if (ionToken) {
    try {
      return await Cesium.IonImageryProvider.fromAssetId(ION_IMAGERY_ASSET_ID);
    } catch (error) {
      // A token ion refuses must not cost the demo its globe. It does earn a
      // warning: on screen a refused token and no token look identical, and
      // neither cause — a missing scope, an origin the token does not allow —
      // is visible from the globe.
      console.warn(`Cesium ion asset ${ION_IMAGERY_ASSET_ID} unavailable:`, error);
    }
  }
  return Cesium.TileMapServiceImageryProvider.fromUrl(
    Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
  );
}

/**
 * Terrain for the globe, best-effort.
 *
 * Without it the globe is the bare WGS84 ellipsoid and the imagery has no
 * height, so a file whose points sit 100 m up — Autzen's lowest does, once
 * the geoid correction above lands it near true HAE — hovers over its own
 * ground by that much. Needs the same ion token the imagery does; without
 * one the demo keeps the ellipsoid.
 */
async function baseTerrain() {
  if (!ionToken) return undefined;
  try {
    return await Cesium.createWorldTerrainAsync();
  } catch (error) {
    // Same bargain as the imagery: no terrain is a worse picture, not a broken
    // demo, so the globe survives it — loudly enough to be diagnosed.
    console.warn('Cesium World Terrain unavailable:', error);
    return undefined;
  }
}

const viewer = new Cesium.Viewer('globe', {
  // Added below instead, so the fallback above can do its job.
  baseLayer: false,
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#11161c');
viewer.scene.globe.depthTestAgainstTerrain = true;
void baseImagery().then((provider) => {
  viewer.imageryLayers.addImageryProvider(provider);
});
void baseTerrain().then((provider) => {
  if (provider !== undefined) viewer.terrainProvider = provider;
});

let provider;

function toggles() {
  return { ground: els.ground.checked, colorByClass: els.colorByClass.checked };
}

async function load(url) {
  els.load.disabled = true;
  say('loading…');

  if (provider !== undefined) {
    // Releases the tileset, the Workers, and every outstanding reservation.
    provider.destroy();
    provider = undefined;
  }

  try {
    provider = await showCopc(viewer, url);
    applyStyle(provider, toggles());

    const stats = provider.stats();
    say(
      `ready — ${stats.range.requests} range requests, ` +
        `${(stats.range.bytesRequested / 1e6).toFixed(1)} MB read, ` +
        `${stats.registryEntries} tiles known`,
      'ok',
    );
  } catch (error) {
    // Verbatim. Every failure this library raises is a typed error whose
    // message names the fix — a missing CRS registration prints the
    // registerCrs call to paste, a server that hides Content-Range prints the
    // header to add. Rewriting them here would throw that away.
    say(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    els.load.disabled = false;
  }
}

els.load.addEventListener('click', () => void load(els.url.value.trim()));
els.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void load(els.url.value.trim());
});
for (const el of [els.ground, els.colorByClass]) {
  el.addEventListener('change', () => {
    if (provider !== undefined) applyStyle(provider, toggles());
  });
}

void load(DEFAULT_URL);
