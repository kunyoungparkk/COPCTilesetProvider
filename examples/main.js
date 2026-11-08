import * as Cesium from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

// Autzen, the classic LiDAR test scene, stored in EPSG:2992 (Oregon Statewide
// Lambert, international feet). Streamed straight from its public bucket,
// cross-origin, which is the demo's point: nothing is copied or re-hosted for
// this page to work.
const FILE_URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

// Geoid height at Autzen (44.0587, -123.0687), from NOAA's NGS geoid service.
// Autzen's Z is NAVD88 orthometric, so without this the points sit that far
// above the terrain they were surveyed on. The value belongs to this dataset's
// location, not to the library.
const AUTZEN_GEOID_HEIGHT = -23.333;

// Google Maps 2D Satellite, in the account the deploy token belongs to.
const ION_IMAGERY_ASSET_ID = 3830182;

// Written into the page at deploy time (.github/workflows/pages.yml). Assigned
// only when it is there: an empty string would replace the token Cesium ships
// with, which is what an ion-less local run falls back on.
const ionToken = globalThis.CESIUM_ION_TOKEN;
if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

// CesiumWidget rather than Viewer: the globe with none of the timeline, clock,
// base layer picker, geocoder or info box a Viewer brings, and so none of the
// options it would take to switch each of them off. Credits still render, which
// is what keeps the imagery's attribution intact.
const widget = new Cesium.CesiumWidget('globe', {
  // Added by useBaseLayer below, so that a failing one can be swapped out.
  baseLayer: false,
  // Cesium's own asset, so the Google quota below does not reach it.
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

// The globe's imagery, best first. Google's tiles reach the page through ion,
// which fetches them from Google under its own key, and when that key's daily
// quota runs out every tile comes back 429 and the globe is bare blue
// (2026-11-03: "2D Tiles requests per day", the same on Cesium 1.146 and
// 1.147). Bing also comes through ion, but not through Google's quota. Natural
// Earth II ships inside Cesium, so no account or quota stands between it and
// the page: blurry up close, never blank.
const BASE_LAYERS = [
  () =>
    Cesium.ImageryLayer.fromProviderAsync(
      Cesium.IonImageryProvider.fromAssetId(ION_IMAGERY_ASSET_ID),
    ),
  () => Cesium.ImageryLayer.fromWorldImagery(),
  () =>
    Cesium.ImageryLayer.fromProviderAsync(
      Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
      ),
    ),
];

// One failure moves to the next layer: the provider not being created (no
// token, ion unreachable) or any one of its tiles failing to load. A spent
// quota fails every tile after the first, and a globe full of holes reads
// worse than a plainer one that is whole. The warning stays because on
// screen a fallback looks like nothing went wrong.
function useBaseLayer(index) {
  const layer = BASE_LAYERS[index]();
  widget.imageryLayers.add(layer);
  if (index === BASE_LAYERS.length - 1) return;

  let failed = false;
  const fallBack = (error) => {
    // Tiles already in flight keep failing after the first one does.
    if (failed) return;
    failed = true;
    console.warn('Base imagery failed; trying the next one.', error);
    widget.imageryLayers.remove(layer);
    useBaseLayer(index + 1);
  };
  layer.errorEvent.addEventListener(fallBack);
  layer.readyEvent.addEventListener((provider) => {
    provider.errorEvent.addEventListener(fallBack);
  });
}
useBaseLayer(0);

const out = document.getElementById('stats');

// Held outside the block so a failure after the counter starts can silence it.
// Without that, the catch below writes the error and the very next frame paints
// the counter back over it.
let stopCounting;

try {
  const provider = await COPCTilesetProvider.fromUrl(FILE_URL, {
    geoidHeight: AUTZEN_GEOID_HEIGHT,
  });
  widget.scene.primitives.add(provider);

  const tileset = provider.tileset;

  // Point shading, which Cesium leaves off: without it every point is one
  // pixel, trees read as flat smudges and the ground stripes. Measured on this
  // file (2026-10-15, same tiles and camera, only these settings changed),
  // attenuation capped at 2 px read closest to Potree. The cap matters more
  // than the switch. Cesium sizes an attenuated point by its own tile's
  // geometric error, and under ADD refinement (Decision 6) the coarse
  // ancestors' points stay on screen at full size, so Cesium's default cap of
  // 5 px turns them into blocks.
  //
  // Eye-dome lighting starts off, and has to be said: Cesium turns it on with
  // attenuation unless told otherwise. It is not lighting. It darkens each
  // pixel by how far it sits behind its neighbours, so every depth jump gets a
  // dark outline, the gaps between points up close included, and over this
  // file's photographic RGB, which already carries the sun's shading, that
  // reads as drawn-on edges. The panel's switch turns it on; it helps most in
  // the elevation, intensity and classification colours, which have no
  // shading of their own. These are tileset settings, not library ones: the
  // panel's size slider and EDL switch write the same fields.
  tileset.pointCloudShading.attenuation = true;
  tileset.pointCloudShading.maximumAttenuation = 2;
  tileset.pointCloudShading.eyeDomeLighting = false;

  // Nothing below is a feature of this library either. The worker writes
  // Classification and Intensity into the PNTS batch table (Decision 6), and
  // that is the whole reason Cesium's own style language can address them —
  // these expressions compile into the point cloud shader exactly as they
  // would on any other 3D Tiles content, so switching never re-requests or
  // re-decodes a tile.
  //
  // The class conditions are ASPRS codes chosen against what this file
  // actually carries, counted over its root node: 5 high vegetation 47.5%,
  // 2 ground 39.4%, 9 water 5.0%, 0 never-classified 3.6%, 6 building 2.7%,
  // and a tail of user-defined codes at or above 64. Low and medium vegetation
  // (3, 4) are absent, so `No vegetation` turns on removing 5 alone; the range
  // is written out anyway because it is the classification's meaning, not this
  // file's. The trailing `true` catches the tail, so no point goes uncoloured.
  //
  // Intensity is a 16-bit field whose spread belongs to the sensor, not the
  // format. Sampled over this file's first nine nodes, the median is 5,376
  // and the 95th percentile 42,752, so the ramp saturates at 43,000 and its
  // square root lifts the dark majority off black.
  //
  // Elevation has no attribute of its own: positions reach the shader as
  // ECEF, so height comes from `POSITION_ABSOLUTE` projected onto the
  // ellipsoid normal under the dataset's centre. Over a footprint this small
  // the curvature that ignores is a few centimetres. The ramp spans the root
  // tile's region heights, which are the header's Z range (Decision 6), from
  // blue at the lowest point to red at the highest.
  const centre = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
  const ground = Cesium.Cartesian3.fromRadians(centre.longitude, centre.latitude, 0);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(ground, new Cesium.Cartesian3());
  const { minimumHeight, maximumHeight } = tileset.root.boundingVolume;
  const height =
    `dot(\${POSITION_ABSOLUTE}, vec3(${up.x}, ${up.y}, ${up.z}))` +
    ` - ${Cesium.Cartesian3.dot(ground, up) + minimumHeight}`;
  const elevation = `clamp((${height}) / ${maximumHeight - minimumHeight}, 0.0, 1.0)`;
  const intensity = '255.0 * sqrt(clamp(${Intensity} / 43000.0, 0.0, 1.0))';

  const COLOURS = {
    rgb: undefined,
    byClass: {
      conditions: [
        ['${Classification} === 2', 'color("#a8794f")'],
        ['${Classification} >= 3 && ${Classification} <= 5', 'color("#3f9142")'],
        ['${Classification} === 6', 'color("#cf6a55")'],
        ['${Classification} === 9', 'color("#3b7dd8")'],
        ['true', 'color("#9aa0a6")'],
      ],
    },
    intensity: `rgb(${intensity}, ${intensity}, ${intensity})`,
    elevation: `hsl(0.66 * (1.0 - ${elevation}), 0.9, 0.5)`,
  };
  const SHOW = {
    all: undefined,
    ground: '${Classification} === 2',
    noVegetation: '${Classification} < 3 || ${Classification} > 5',
  };

  // One style from both choices, rebuilt on every change: Cesium3DTileStyle
  // takes colour and show together, and a style is cheap next to the shader
  // recompile Cesium does for it anyway.
  const panel = document.getElementById('panel');
  const choice = (name) => panel.querySelector(`input[name="${name}"]:checked`).value;
  panel.hidden = false;
  panel.addEventListener('input', () => {
    const color = COLOURS[choice('colour')];
    const show = SHOW[choice('show')];
    tileset.style =
      color || show ? new Cesium.Cesium3DTileStyle({ color, show }) : undefined;
    tileset.pointCloudShading.eyeDomeLighting = panel.querySelector('#edl').checked;
    tileset.pointCloudShading.maximumAttenuation = Number(panel.querySelector('#size').value);
  });

  // The reading this page exists to show, refreshed on `postRender` rather than
  // on a timer: that event means Cesium has just finished a frame, which is
  // also when it has just finished asking for tiles, so the number is as fresh
  // as the picture beside it. Written only when it changes — the counts hold
  // still for long stretches whenever the camera does.
  let last;
  stopCounting = widget.scene.postRender.addEventListener(() => {
    const { requests, bytesRequested } = provider.stats().range;
    const text = `${requests} range requests\n${(bytesRequested / 1e6).toFixed(1)} MB read`;
    if (text === last) return;
    last = text;
    out.textContent = text;
  });

  widget.camera.flyToBoundingSphere(provider.tileset.boundingSphere, {
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(30), Cesium.Math.toRadians(-32), 0),
  });
} catch (error) {
  stopCounting?.();
  // Verbatim. Every failure this library raises is a typed error whose message
  // names the fix — a file on a datum it cannot place prints the `crs` call to
  // paste, a server that hides Content-Range prints the header to add.
  // Rewriting them here would throw that away.
  out.textContent = error instanceof Error ? error.message : String(error);
  out.className = 'error';
}
