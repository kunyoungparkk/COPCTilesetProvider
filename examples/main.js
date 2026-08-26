import * as Cesium from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

// Autzen, the classic LiDAR test scene, stored in EPSG:2992 (Oregon Statewide
// Lambert, international feet). Streamed straight from its public bucket,
// cross-origin, which is the demo's point: nothing is copied or re-hosted for
// this page to work.
const FILE_URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

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
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.IonImageryProvider.fromAssetId(ION_IMAGERY_ASSET_ID),
  ),
  // Both of these need the ion token. Without one the globe comes up blank —
  // fine, because a local run has no dataset to show over it either.
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

const out = document.getElementById('stats');

// Held outside the block so a failure after the counter starts can silence it.
// Without that, the catch below writes the error and the very next frame paints
// the counter back over it.
let stopCounting;

try {
  COPCTilesetProvider.registerCrs(2992, OREGON);

  const provider = await COPCTilesetProvider.fromUrl(FILE_URL, {
    geoidHeight: AUTZEN_GEOID_HEIGHT,
  });
  widget.scene.primitives.add(provider);

  // Nothing below is a feature of this library. The worker writes
  // Classification into the PNTS batch table (Decision 6), and that is the
  // whole reason Cesium's own style language can address it — these
  // expressions compile into the point cloud shader exactly as they would on
  // any other 3D Tiles content.
  //
  // The conditions are ASPRS codes chosen against what this file actually
  // carries, counted over its root node: 5 high vegetation 47.5%, 2 ground
  // 39.4%, 9 water 5.0%, 0 never-classified 3.6%, 6 building 2.7%, and a tail
  // of user-defined codes at or above 64. Low and medium vegetation (3, 4) are
  // absent, so `No vegetation` turns on removing 5 alone; the range is written
  // out anyway because it is the classification's meaning, not this file's.
  // The trailing `true` catches the tail, so no point goes uncoloured.
  const STYLES = {
    all: undefined,
    byClass: new Cesium.Cesium3DTileStyle({
      color: {
        conditions: [
          ['${Classification} === 2', 'color("#a8794f")'],
          ['${Classification} >= 3 && ${Classification} <= 5', 'color("#3f9142")'],
          ['${Classification} === 6', 'color("#cf6a55")'],
          ['${Classification} === 9', 'color("#3b7dd8")'],
          ['true', 'color("#9aa0a6")'],
        ],
      },
    }),
    ground: new Cesium.Cesium3DTileStyle({ show: '${Classification} === 2' }),
    noVegetation: new Cesium.Cesium3DTileStyle({
      show: '${Classification} < 3 || ${Classification} > 5',
    }),
  };

  const filters = document.getElementById('filters');
  filters.hidden = false;
  filters.addEventListener('change', (event) => {
    provider.tileset.style = STYLES[event.target.value];
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
  // names the fix — a missing CRS registration prints the registerCrs call to
  // paste, a server that hides Content-Range prints the header to add.
  // Rewriting them here would throw that away.
  out.textContent = error instanceof Error ? error.message : String(error);
  out.className = 'error';
}
