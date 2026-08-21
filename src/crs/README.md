# crs

The coordinate pipeline, and the realm rule Decision 3 puts on one part of it.

`resolveCrsDefinition(wkt)` reads the horizontal EPSG code out of the file's WKT and answers with the proj4 definition registered for it, or throws saying which code went unregistered. `createTransformFromDefinition(definition)` turns that answer into a `CrsTransform`, whose two members project file coordinates to WGS84 degrees and metres (`toWgs84`, which the tileset's regions are built from) and to ECEF metres (`toEcef`).

The rule is about the registry, not about the builder. The registry is module state, so it lives in whichever realm imported it — and a Worker gets its own copy, holding only the default EPSG:4326 however much the caller registered. So the registry stays on the main thread, and what crosses to a Worker is the resolved definition string; the transform itself is a closure and could not cross in any case. `createTransformFromDefinition` is realm-free: the main thread builds one at `fromUrl` time, for the synthetic tileset's regions and its root geometric error. `worker.ts` exists to make the separation checkable rather than to say where the builder runs — `tests/crs-worker-boundary.test.ts` walks everything that entry can reach, statically or dynamically, and fails if the registry is among it.

Three v1 limits. Height is ellipsoidal — no geoid correction, per §6. z is taken to be in the same linear unit as x and y, because proj4 scales only the horizontal pair and the registered definition is where that unit is read from; a file measuring height in some other unit comes out vertically scaled. And a registered definition has to stand on its own: one naming `+nadgrids`, or written as a `proj4.defs` alias, depends on realm-global state that does not cross with the string, which on proj4 2.21 shows up as `[NaN, NaN]` coordinates or a thrown non-Error.

OVERVIEW §3, Decision 3 and Decision 6.
