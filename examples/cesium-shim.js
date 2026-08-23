// The library imports `cesium` as a bare specifier. This page loads Cesium's
// official CDN build, which defines a global rather than a module, so the
// import map points `cesium` here and this hands back that one instance.
//
// Two instances would not merely waste bandwidth: `provider.tileset` would be
// a Cesium3DTileset from a different copy of the engine than the one this
// page's scene knows how to add, and `scene.primitives.add(provider)` would
// fail on a class identity check.
//
// These five names are everything the published bundle asks `cesium` for —
// three imported statically, two through the dynamic import the codec uses to
// reach Cesium's content constructors.
const Cesium = globalThis.Cesium;

if (!Cesium) {
  throw new Error(
    'Cesium is not loaded. index.html must load the CesiumJS CDN script before ' +
      'any module that imports it.',
  );
}

export const Cesium3DTileset = Cesium.Cesium3DTileset;
export const Rectangle = Cesium.Rectangle;
export const Resource = Cesium.Resource;
export const Model3DTileContent = Cesium.Model3DTileContent;
export const Tileset3DTileContent = Cesium.Tileset3DTileContent;
