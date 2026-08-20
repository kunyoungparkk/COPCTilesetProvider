# crs

The coordinate pipeline, in two halves that Decision 3's realm boundary runs between.

`resolveCrsDefinition(wkt)` is the main thread's half: it reads the horizontal EPSG code out of the file's WKT and answers with the proj4 definition registered for it, or throws saying which code went unregistered. `createTransformFromDefinition(definition)` is the other half, and projects file coordinates into ECEF metres.

The registry is module state, so it lives in whichever realm imported it — and a Worker gets its own copy, holding only the default EPSG:4326 however much the caller registered. So the registry stays on the main thread, and what crosses the boundary is the resolved definition string; the transform itself is a closure and could not cross in any case. Each side has its own entry point — `index.ts` here, `worker.ts` there — because a shared barrel would carry the registry across whatever the rule said. `tests/crs-worker-boundary.test.ts` walks everything `worker.ts` can reach, statically or dynamically, and fails if the registry is among it.

Three v1 limits. Height is ellipsoidal — no geoid correction, per §6. z is taken to be in the same linear unit as x and y, because proj4 scales only the horizontal pair and the registered definition is where that unit is read from; a file measuring height in some other unit comes out vertically scaled. And a registered definition has to stand on its own: one naming `+nadgrids`, or written as a `proj4.defs` alias, depends on realm-global state that does not cross with the string, which on proj4 2.21 shows up as `[NaN, NaN]` coordinates or a thrown non-Error.

OVERVIEW §3, Decision 3 and Decision 6.
