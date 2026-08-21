# worker

The off-main-thread pipeline that turns one COPC chunk's compressed bytes into
a PNTS tile. `encodeNode({ compressed, header, pointCount, definition })` is
the module's single entry point, composing the three stages OVERVIEW §4 names
for a point tile: `decodeChunk` decompresses the chunk into a readable point
view, `toRelativePositions` transforms it to ECEF and re-centres it on the
tile's own bounding-box midpoint for float32 precision, and `encodePnts`
writes the 3D Tiles 1.0 PNTS bytes, batch table included, so GPU styling and
picking can reference LAS attributes. A chunk that decodes to zero points is
refused with a typed `ZeroPointChunkError` rather than reaching the encoder —
Decision 6 forbids serving an empty PNTS by any path.

`definition` is an already-resolved proj4 string, not a CRS code: resolving a
code needs the registry, which is main-thread-only module state (`src/crs/`) —
a Worker's own copy would hold none of what the caller registered. This
module's import closure cannot reach that registry or its resolver
(`tests/worker-boundary.test.ts` walks it the same way
`tests/crs-worker-boundary.test.ts` walks `src/crs/worker.ts`'s), so the
resolved string is the only form a CRS definition can cross the boundary in.

Two limits worth knowing. The batch table's property names and types —
`Classification`, `Intensity`, `GpsTime`, `ReturnNumber`, `NumberOfReturns` —
become a contract once a version ships with them: a caller's Cesium style
strings and picking code get written against this exact set, so narrowing or
removing one afterward breaks their code, not this library's. `PointSourceId`
is deliberately excluded, on the shape of the bet rather than a guess at
demand: adding a property later keeps every existing style string working,
while removing or narrowing one does not — so omission is the reversible
half. And `BATCH_ID` and the GPS time convention cannot be
revisited separately: Cesium's `PntsLoader` builds a property *table* only
when batch IDs are present, where a batch table's `DOUBLE` transcodes to
`FLOAT64` and precision survives; without them it falls back to property
*attributes*, where every value is cast to `Float32Array`. Which GPS time
convention a file actually uses (LAS's `globalEncoding` bit chooses between
GPS Week Time and Adjusted Standard GPS Time) is the file's decision, not this
module's, so `GpsTime` has to stay a `DOUBLE` — and `BATCH_ID` present — for
whichever convention a given file turns out to carry.

OVERVIEW §3, Decision 3 and Decision 6.
