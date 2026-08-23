// The consumer's code. Every import here names a package, not a path — this
// file is copied into a project that installed the tarball and knows nothing
// about this repository.
import { Color, Viewer } from 'cesium';
import { COPCTilesetProvider } from 'copc-tileset-provider';

const OREGON =
  '+proj=lcc +lat_0=41.75 +lon_0=-120.5 +lat_1=43 +lat_2=45.5 ' +
  '+x_0=399999.9999984 +y_0=0 +datum=NAD83 +units=ft +no_defs';

// Counting pixels only means anything against a black sky: the Decision 2 gate
// found the starfield alone doubled its count.
function blackout(viewer) {
  const scene = viewer.scene;
  for (const name of ['globe', 'skyBox', 'skyAtmosphere', 'sun', 'moon']) {
    if (scene[name]) scene[name].show = false;
  }
  scene.backgroundColor = Color.BLACK;
}

function litPixels(canvas) {
  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const ctx = scratch.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] || data[i + 1] || data[i + 2]) lit++;
  }
  return lit;
}

window.smoke = {
  async run({ withProvider }) {
    const viewer = new Viewer('scene', {
      // Without this the drawing buffer is cleared before anything can read it.
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
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
    blackout(viewer);
    viewer.useDefaultRenderLoop = false;
    const render = () => {
      viewer.scene.initializeFrame();
      viewer.scene.render();
    };

    if (!withProvider) {
      for (let i = 0; i < 60; i++) render();
      return { litPixels: litPixels(viewer.scene.canvas), pointsLength: 0, tilesLoaded: true };
    }

    COPCTilesetProvider.registerCrs(2992, OREGON);
    // No second argument. This line is the whole point of the sub-project: no
    // spawnWorker, no wasm to serve, no adapter to write.
    const provider = await COPCTilesetProvider.fromUrl(
      new URL('/data/one.copc.laz', location.href).href,
    );
    viewer.scene.primitives.add(provider);
    viewer.camera.setView({ destination: provider.extent });
    viewer.camera.moveBackward(400);

    for (let i = 0; i < 400 && !provider.tileset.tilesLoaded; i++) {
      render();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let i = 0; i < 10; i++) render();

    return {
      litPixels: litPixels(viewer.scene.canvas),
      pointsLength: provider.tileset.statistics.numberOfPointsSelected,
      tilesLoaded: provider.tileset.tilesLoaded,
    };
  },
};
