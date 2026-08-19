# cesium-runtime

The only place in this library that touches CesiumJS, including the private `_runtimeContentCodec` slot that supplies tile content. Point styling and classification filters are delegated to `Cesium3DTileStyle`.

OVERVIEW §3, Decisions 1, 2, and 6.
