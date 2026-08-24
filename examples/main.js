import * as Cesium from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

// Autzen, the classic LiDAR test scene, stored in EPSG:2992 (Oregon Statewide
// Lambert, international feet). Served from this same origin — see
// examples/README.md for why the demo does not stream it from its public
// bucket.
const FILE_URL = new URL('./data/autzen-classified.copc.laz', location.href).href;

const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Geoid height at Autzen (44.0587, -123.0687), from NOAA's NGS geoid service.
// Autzen's Z is NAVD88 orthometric, so without this the points sit that far
// above the terrain they were surveyed on. The value belongs to this dataset's
// location, not to the library.
const AUTZEN_GEOID_HEIGHT = -23.333;

// ---------------------------------------------------------------------------
// Using the library. This is the whole of it.
// ---------------------------------------------------------------------------

/** Registers the file's coordinate system, opens it, and puts it on the globe. */
async function showCopc(viewer, url) {
  COPCTilesetProvider.registerCrs(2992, OREGON);

  const provider = await COPCTilesetProvider.fromUrl(url, {
    geoidHeight: AUTZEN_GEOID_HEIGHT,
  });
  viewer.scene.primitives.add(provider);

  return provider;
}

// ---------------------------------------------------------------------------
// Page wiring. Nothing below is part of using the library.
// ---------------------------------------------------------------------------

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
 * inside Cesium's own build and cannot fail or be rate-limited.
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
 * height, so a file whose points sit 100 m up — Autzen's lowest does, once the
 * geoid correction above lands it near true HAE — hovers over its own ground by
 * that much. Needs the same ion token the imagery does.
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

const out = document.getElementById('stats');

/**
 * The reading this page exists to show: how much of the file was actually
 * fetched, for as long as the camera keeps asking for more.
 *
 * On `postRender` rather than on a timer, because that event means Cesium has
 * just finished a frame — which is also when it has just finished asking for
 * tiles, so the number is as fresh as the picture beside it. The text is
 * compared before it is written: the counts hold still for long stretches
 * whenever the camera does, and an unchanged string is not worth a DOM write.
 */
function countRangeRequests(provider) {
  let last;
  viewer.scene.postRender.addEventListener(() => {
    const { requests, bytesRequested } = provider.stats().range;
    const text = `${requests} range requests\n${(bytesRequested / 1e6).toFixed(1)} MB read`;
    if (text === last) return;
    last = text;
    out.textContent = text;
  });
}

try {
  const provider = await showCopc(viewer, FILE_URL);
  // Started before the flight rather than after it, so the counter is running
  // while the camera is still pulling the tiles it counts.
  countRangeRequests(provider);
  await viewer.flyTo(provider.tileset, {
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(30), Cesium.Math.toRadians(-32), 0),
  });
} catch (error) {
  // Verbatim. Every failure this library raises is a typed error whose message
  // names the fix — a missing CRS registration prints the registerCrs call to
  // paste, a server that hides Content-Range prints the header to add.
  // Rewriting them here would throw that away.
  out.textContent = error instanceof Error ? error.message : String(error);
  out.className = 'error';
}
