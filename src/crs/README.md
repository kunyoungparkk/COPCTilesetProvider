# crs

The coordinate pipeline: reads the horizontal EPSG code out of the file's WKT, resolves it against registered proj4 definitions, and projects file coordinates into ECEF metres.

Two v1 limits on height. It is ellipsoidal — no geoid correction, per §6. And z is taken to be in the same linear unit as x and y, because proj4 scales only the horizontal pair and the registered definition is where that unit is read from; a file measuring height in some other unit comes out vertically scaled.

The registry is module state, so it lives in whichever realm imported it. Decision 3 puts the transform in a Worker, which is a separate realm: a caller's `registerCrs` on the main thread is invisible there. What crosses the boundary has to be the resolved definition, not the registration.

OVERVIEW §3, Decision 6.
