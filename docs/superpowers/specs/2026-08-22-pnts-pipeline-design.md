# PNTS encoding pipeline — design

**Goal.** Turn one COPC node's compressed bytes into the PNTS tile Cesium
renders, in one pass that never lets the point array cross a boundary.

**Spec.** `OVERVIEW.md` — §3 Decision 3 (heavy work in a Worker, only
compressed input and encoded output move), Decision 6 (PNTS + batch table,
RTC_CENTER with float32 relatives, the empty-node invariant), §6 (v1
non-goals), §7 (Worker pool size, the deferred quantisation).

## Scope

This is half of the Worker sub-project: the **pipeline**, as pure functions.
Compressed chunk bytes in, PNTS bytes out.

Out of scope, and belonging to the other half: the Worker pool, the message
protocol, transferable handoff, and the codec that installs the result into
Cesium.

The pipeline includes the LAZ decode. The alternative — starting from
already-decompressed points — would leave the encoder verified only against
points this project invented, which is the failure shape that has cost this
codebase four review rounds already. It also keeps the largest intermediate,
the decoded point array, inside one function rather than crossing an interface.

## What crosses in, and the two rules that come with it

The pipeline is handed a **proj4 definition string**, never WKT and never a
registry. `src/crs`'s realm split already fixed this: the registry is module
state, so a Worker's copy holds only EPSG:4326 whatever the caller registered.

Two obligations carried forward from that sub-project, both required here:

1. **`resolveCrsDefinition` runs once on the main thread, at open time**, and
   its answer rides the init message. It throws `CrsNotRegisteredError` and
   `CrsCodeNotFoundError`, which have to surface where `fromUrl` can reject; the
   same throw inside a Worker becomes an opaque `messageerror`. This pipeline's
   entry point therefore takes a definition and has no code path that resolves
   one.
2. **A definition that depends on realm-global proj4 state is rejected with a
   typed error, in `createTransformFromDefinition`.** Measured on proj4 2.21: a
   definition naming `+nadgrids` returns `[NaN, NaN]` in a realm without the
   grid table, with nothing but a console line, and a `proj4.defs` alias throws
   a value that is not an `Error`. Both would otherwise become a cloud of NaN
   positions diagnosed three layers from the cause. The check does not belong
   at this pipeline's own entry seam: the main thread builds a transform too,
   at `fromUrl` time, and the same bad definition then reaches Cesium as
   half-NaN bounding volumes without a throw (measured on the synthetic
   tileset branch: `regionForKey` returns
   `[NaN, NaN, NaN, NaN, 123.79147200000011, 1542.790920000003]` and
   `measureRootGeometricError` returns `NaN`). The builder is the one
   chokepoint both consumers pass through.

## The pipeline

```
chunk bytes + header + definition
  → laz-perf: decompress into LAS point records
  → scale and offset: raw int32 → file coordinates
  → transform: file coordinates → ECEF metres
  → RTC_CENTER and float32 relatives
  → PNTS: header + feature table + batch table
```

**Coordinates.** LAS stores each axis as an int32 scaled by the header's
`scale` and shifted by its `offset`; the pinned file uses 0.01 with an offset
near the middle of its extent. Those file coordinates go through
`CrsTransform.toEcef`, which is where the linear unit is applied.

**RTC_CENTER is the midpoint of the transformed points' ECEF bounding box.**
Decision 6 keeps positions as float32 relative to a tile origin because
absolute ECEF is ~6.4×10⁶ m, where float32 resolves about half a metre. The
midpoint of what the tile actually contains minimises those relatives, which is
the whole point of having an origin; the node's cube centre would be
determined without looking at the points but is a different geometry from the
one being encoded, and on a file like the pinned one the cube reaches far above
the data.

**Attributes.** RGB rides the feature table — the pinned file is point format
7, which carries it. The batch table carries **classification, intensity and
GPS time**: the three a point-cloud viewer actually styles and filters on.
Return number, scan angle and user data are omitted; they cost bytes per point
and are rarely styled, and §7 already lists a GPU-memory optimisation as
deferred rather than prepaid.

**BATCH_ID is per point**, which is what Decision 6 means by picking working:
one batch per point, so a pick resolves to a point and the batch table's rows
line up with it.

### Why GPS time is safe, and what it is safe *because of*

Verified against the installed Cesium 1.143, not assumed. A `pnts` tile is
loaded by `Model3DTileContent.fromPnts` → `PntsLoader` → `Model`;
`Source/Scene/PointCloud.js` serves `TimeDynamicPointCloud` and is not on this
path, which is worth knowing before reading older material about point-cloud
styling.

`PntsLoader` forks on one line (`Source/Scene/Model/PntsLoader.js:557-559`):

> ```js
> // If there are batch IDs, parse as a property table. Otherwise, parse
> // as property attributes.
> const parseAsPropertyAttributes = !defined(parsedContent.batchIds);
> ```

With BATCH_ID the batch table becomes a **property table** — CPU-side metadata,
addressed by feature ID, which is what makes `Cesium3DTileFeature` picking and
`${property}` style conditions work. `Source/Scene/parseBatchTable.js:439-440`
transcodes `"DOUBLE"` to `"FLOAT64"` there, so a GPS time keeps its precision.

Without BATCH_ID the same table becomes **property attributes** — GPU vertex
attributes — and `Source/Scene/parseBatchTable.js:354-364` casts the array,
warning that `"INT, UNSIGNED_INT, and DOUBLE are not valid WebGL vertex
attribute types. Some precision may be lost."` Adjusted standard GPS time runs around
2.4 × 10⁸ s, where float32 resolves roughly 16 seconds.

**So the two choices are coupled.** GPS time as a double is only safe while
BATCH_ID is present; dropping BATCH_ID later would silently degrade it rather
than fail. Anyone revisiting either decision has to revisit both, and that is
the reason this paragraph exists rather than a bare "GPS time is fine".

The cost the property table brings with it: `batchLength` equals the point
count, so a tile becomes as many features as it has points and a style change
is evaluated per feature on the CPU. That is a throughput question for the
sub-project that installs the codec, not a correctness one here.

**Layout becomes a contract on release — this is the last free moment to
change it.** A batch table's property names and types are what a caller's
styles and picking code are written against; once a version ships with
`GpsTime` as a double, removing it or narrowing it breaks their code rather
than ours. The attribute set is therefore decided here, with the Cesium
behaviour verified rather than assumed, and the plan repeats this paragraph so
the person implementing the layout knows what they are fixing in place.

## Zero points is a bug, not a case

Decision 6 forbids serving a zero-point PNTS by any path — such a tile never
reaches ready and `tilesLoaded` waits forever. The synthetic tileset already
omits content for a `pointCount` 0 node, and the COPC specification gives such
a node `offset` 0 and `byteSize` 0, so there is nothing to request. A chunk
that nevertheless decodes to zero points is therefore a defect in this library
or in the file, and fails as a typed error rather than producing an empty tile.

## Per-point cost is measured, not guessed

`toEcef` allocates a tuple per call, and proj4's `forward` allocates another.
A review flagged this as the first thing a Worker decoding millions of points
would hit. v1 calls it per point anyway and **measures** — decode, transform
and encode timed separately on the real chunk fixture, recorded in the plan.
§7's rule is that values move on measurement in a fixed environment, and §7's
own note says prior implementations found decode to be under 1 % of total time.
Adding a write-into-buffer API to `src/crs` on a guess would reopen for a
fourth time a module that has already cost three review rounds.

## The fixture

The repo has no LAZ point data yet. Measured from the pinned root hierarchy,
Autzen's **smallest node is key `5-16-3-1`: 47 points in 951 compressed bytes
at offset 53 565 789** — the same size class as the three fixtures already
committed, and small enough that a human can check the decoded numbers.

That makes the whole pipeline verifiable against real bytes: 47 points decode,
their file coordinates fall inside the header's own bounds, their ECEF
positions land within the node's cube, and the emitted PNTS parses back to 47
points whose relatives plus RTC_CENTER reproduce the ECEF inputs.

The root node — 61 201 points, 763 KB — is deliberately not committed. Nothing
needs it, and `fixtures/README.md`'s rule is that only what a test reads gets
committed.

## Verification

- **Decode against the real chunk**: 47 points, and the count comes from the
  hierarchy entry rather than from the decoder, so the two must agree.
- **Coordinates inside the header's declared bounds**, which the decoder never
  saw — an independent path, as in the tileset sub-project.
- **PNTS round trip**: parse the emitted bytes back and reconstruct positions
  from RTC_CENTER plus the float32 relatives; compare against the ECEF the
  transform produced. This is the assertion that catches a wrong offset,
  a wrong alignment, or an origin that does not match the relatives.
- **RTC_CENTER is inside the tile's own bounding box**, and the largest
  relative is bounded by half the box's diagonal — a property that holds
  whatever the numbers are, and fails immediately if the origin is computed
  from something other than the points.
- **The two definition refusals** get a test each, with the measured proj4
  behaviour quoted in the test's comment so the reason survives.
- **Timings recorded**, not asserted: a test that fails on a slow machine is
  worse than no test, so the measurement is written into the plan and the §7
  table rather than into an assertion.

## Decisions settled — do not relitigate mid-task

- **The pipeline owns the LAZ decode.** Verifying the encoder on invented
  points is the failure shape this project keeps paying for.
- **A definition string crosses; a registry never does.**
- **`+nadgrids` and `proj4.defs` aliases are refused with a typed error.**
- **RTC_CENTER is the transformed points' bounding-box midpoint.**
- **Batch table = classification, intensity, GPS time. RGB is a feature.**
- **BATCH_ID is per point** — and GPS time's precision depends on it, verified
  against Cesium 1.143's own fork between property tables and property
  attributes. The two cannot be revisited separately.
- **Zero points is a typed error.**
- **Per-point `toEcef` stays until a measurement says otherwise.**
