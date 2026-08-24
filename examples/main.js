import { COPCTilesetProvider } from 'copc-tileset-provider';

// Autzen, the classic LiDAR test scene, stored in EPSG:2992 (Oregon Statewide
// Lambert, international feet). Served from this same origin — see
// examples/README.md for why the demo does not stream it from its public
// bucket.
const DEFAULT_URL = new URL('./data/autzen-classified.copc.laz', location.href).href;

const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// ---------------------------------------------------------------------------
// Using the library. This is the whole of it.
// ---------------------------------------------------------------------------

/**
 * Registers the file's coordinate system, opens it, and puts it on the globe.
 * Returns the provider so the caller can style it and, later, destroy it.
 */
async function showCopc(viewer, url) {
  COPCTilesetProvider.registerCrs(2992, OREGON);

  const provider = await COPCTilesetProvider.fromUrl(url);
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

/**
 * Imagery for the globe, best-effort.
 *
 * ion's world imagery is the only thing here sharp enough to recognise ground
 * under the points, and it needs a token. Without one — every local run, and
 * any deploy where the secret is missing — this uses Natural Earth II, which
 * ships inside Cesium's own CDN build and cannot fail or be rate-limited.
 *
 * Cesium's build carries a shared default token that would work without any of
 * this, but it prints a banner across the bottom of the page asking you not to
 * rely on it, and it is rate-limited globally. So the choice is ours or none.
 *
 * The rejection is caught rather than left to Cesium's error event, so no path
 * here logs to the console.
 */
async function baseImagery() {
  const token = globalThis.CESIUM_ION_TOKEN;
  if (token) {
    Cesium.Ion.defaultAccessToken = token;
    try {
      return await Cesium.IonImageryProvider.fromAssetId(2);
    } catch {
      // Fall through. A revoked or rate-limited token must not cost the demo
      // its globe.
    }
  }
  return Cesium.TileMapServiceImageryProvider.fromUrl(
    Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
  );
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
