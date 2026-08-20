# Synthetic 3D Tiles — design

**Goal.** Turn a COPC hierarchy page into a 3D Tiles 1.0 tileset that Cesium can
traverse, and into the registry that lets the intercepting layer map a tile's
URI back to the byte range it stands for.

**Spec.** `OVERVIEW.md` — §3 Decision 1 (borrow Cesium's traversal), Decision 2
(the codec contract's three constraints), Decision 6 (refine, geometricError,
boundingVolume, the empty-node invariant), §4 (the runtime flow), §7 (the
tuning knobs this consumes).

## Scope

In: the page-to-tileset transformation and the URI registry that comes with it.

Out: PNTS encoding, LAZ decode, Worker plumbing (their own sub-project); Blob
URL creation, codec installation, and the `Resource` interception that consumes
these URIs (sub-project 8); camera framing, which Decision 6 computes from the
header's measured extent rather than from anything here.

The module is pure and synchronous. It does not fetch, does not touch Cesium,
and does not know what a Blob is.

## Inputs and outputs

```ts
export interface TilesetContext {
  /**
   * Absolute URI prefix every tile's content URI is built on.
   *
   * The caller owns the scheme because the caller owns the interception.
   * Contract: absolute (a scheme is required — Decision 2's first constraint
   * is that relative resolution against a Blob URL does not work), ends with
   * `/`, and contains only characters that survive URI normalisation
   * unescaped. It must also be stable for the life of the provider instance,
   * since the registry's keys are built from it, and unique per instance, so
   * two tilesets on one globe cannot collide.
   */
  readonly tokenBase: string;
  /** `info.cube` — the octree root, which every node's cube is stepped from. */
  readonly cube: Bounds;
  /** The key this page is rooted at. `0-0-0-0` for the file's root page. */
  readonly rootKey: NodeKey;
  /** The whole file's root geometric error; each tile halves it per depth. */
  readonly rootGeometricError: number;
  readonly transform: CrsTransform;
}

/** What a tile's URI stands for. Both shapes are assignable to `ByteRange`. */
export type TileEntry =
  | { kind: 'points'; key: NodeKey; offset: number; length: number; pointCount: number }
  | { kind: 'hierarchy'; key: NodeKey; offset: number; length: number };

/**
 * The 3D Tiles 1.0 document, declared structurally here. No 3D Tiles type
 * package is added for it — §5 fixes the dependency list, and the subset this
 * module emits is small enough to state.
 */
export interface SyntheticTileset {
  readonly json: TilesetJson;
  /** Keyed by the full content URI, which is what the interceptor holds. */
  readonly entries: ReadonlyMap<string, TileEntry>;
}

export function buildTileset(page: HierarchyPage, context: TilesetContext): SyntheticTileset;

/** The root geometric error, measured once at open time and reused per page. */
export function measureRootGeometricError(header: Las.Header, transform: CrsTransform): number;
```

The root page and every sub-page go through the same `buildTileset`. Decision
2's second constraint — that a hierarchy tile expands into an external tileset —
is served by calling this function again rather than by a second code path.

## Tree shape

One tile per page entry, nested by octree parentage: the parent of
`(d, x, y, z)` is `(d-1, ⌊x/2⌋, ⌊y/2⌋, ⌊z/2⌋)`. The tileset's root tile is the
tile for `context.rootKey`.

`refine` is `ADD`, set on the root tile only; 3D Tiles 1.0 inherits it. Decision
6's reasoning: COPC nodes are a non-overlapping sample, so a volume's full
resolution is the union along the path from the root, which is what ADD means.

- **A node entry** becomes a tile whose content URI is `<tokenBase>n/<d-x-y-z>`,
  registered as a `points` entry — **unless its `pointCount` is 0**, in which
  case the tile is emitted with no `content` at all. Decision 6 forbids serving
  a zero-point PNTS by any path: such a tile never reaches ready and
  `tilesLoaded` waits forever. The tile itself stays, because children may hang
  from it.
- **A page entry** becomes a tile whose content URI is `<tokenBase>h/<d-x-y-z>`,
  registered as a `hierarchy` entry. The interceptor fetches the page bytes and
  the codec expands them into an external tileset whose own root is the tile for
  that same key — this time carrying the real point content, because the node's
  data entry lives inside the sub-page rather than in the page that points at
  it.

### What the specification says an entry can be

COPC 1.0 gives one `Entry` struct three meanings, selected by `pointCount`
(quoted verbatim from the specification):

> ```
> // Absolute offset to the data chunk if the pointCount > 0.
> // Absolute offset to a child hierarchy page if the pointCount is -1.
> // 0 if the pointCount is 0.
> uint64_t offset;
>
> // If > 0, represents the number of points in the data chunk.
> // If -1, indicates the information for this octree node is found in another
> //        hierarchy page.
> // If 0, no point data exists for this key, though may exist for child entries.
> int32_t pointCount;
> ```

Three things follow, and each settles a question this module would otherwise
have had to guess at.

**A zero-point node has no bytes at all** — `offset` and `byteSize` are both 0.
There is nothing to range-request even if we wanted to, which is Decision 6's
empty-node rule arriving from the other direction.

**A contentless tile with children is the specification's own shape**, not an
invention of this design: *"no point data exists for this key, though may exist
for child entries."*

**Empty nodes are represented, not omitted.** That removes the case this design
briefly tried to accommodate — a writer that skips empty nodes and thereby
leaves a child with no parent in the page. The format's answer to an empty node
is an entry with `pointCount` 0, so an absent parent is not the ordinary
consequence of a sparse cloud.

### Contradictions and gaps are both refused

**A key is a node or a page pointer, never both** within one page. The two
meanings are alternatives of one `pointCount` field, so an overlap means two
entries disagree about where that node's data is, and nothing here can choose.

**An entry whose parent is absent from the page** cannot be placed in the tree.
The specification does not require the hierarchy to be a complete tree, but it
does not license a gap either, and it supplies `pointCount` 0 for the one case
that would otherwise produce one. With no normative basis and no observed writer
that does it, synthesising an ancestor would mean inventing a tile out of a
guess about what the file meant.

**An entry outside the subtree rooted at `rootKey`** belongs to a different
page.

All three raise `MalformedHierarchyError`, which already blames the file and
names the offending entry.

## The numbers

### geometricError

Decision 6: the root's **measured metre span** divided by N, halved per depth,
where the span is the larger of horizontal and vertical.

Two things follow. The span comes from the **header's** `min`/`max`, not from
`info.cube`, which is padded to a cube and reaches far above the data. And the
file's units are not metres — Autzen's are international feet.

Metres are obtained by measuring, not by exposing a unit scale: transform pairs
of header corners and take the ECEF distance between them. That is what
"measured metres" means literally, and it reuses a transform whose correctness
is already pinned.

```
origin = toEcef(minx, miny, minz)
xSpan  = |toEcef(maxx, miny, minz) − origin|
ySpan  = |toEcef(minx, maxy, minz) − origin|
zSpan  = |toEcef(minx, miny, maxz) − origin|
rootGeometricError = max(xSpan, ySpan, zSpan) / N          // N = 16, §7
geometricError(tile) = rootGeometricError / 2^depth(tile.key)
```

Measured on the pinned fixture (`fixtures/autzen-head.bin`, header
`min [635577.79, 848882.15, 406.14]`, `max [639003.73, 853537.66, 615.26]`,
EPSG:2992 registered as the `+units=ft` Lambert conformal conic the tests use):
xSpan 1044.49 m, ySpan 1419.36 m, zSpan 63.74 m, so the root geometric error is
**88.710 m**. Every pinned constant in the tests carries its derivation like
this — which corners, through which formula — so a reader can re-derive it by
hand. A number nobody can re-derive is not an external reference.

The depth used is the key's **absolute** depth, never its depth within the page.
That is what makes a page-pointer tile and the root of the tileset it expands
into agree, since they are the same key.

The tileset's own top-level `geometricError` is the root tile's.

### boundingVolume

A WGS84 `region`: `[west, south, east, north, minHeight, maxHeight]`, angles in
radians, heights in metres. Decision 6 chose it to avoid computing ECEF box
geometry, and requires the volume to fully contain its tile's data.

The node's cube comes from copc.js's `Bounds.stepTo(context.cube, key)` — the
same subdivision the file itself used, so there is no second implementation to
disagree with it.

Heights are the cube's own z values, per Decision 6, converted to metres by the
transform. That is why `CrsTransform` gains `toWgs84(x, y, z)` returning
`[longitude, latitude, heightMetres]`: `region` needs degrees and metres, and
`toEcef` already computes all three internally before consuming them. This is
the only change to `src/crs` — the module is reopened for it and nothing else.

The height that comes back depends only on `z`, since the transform scales it by
the definition's linear unit and leaves the horizontal pair to proj4, so the
`x`/`y` passed alongside are immaterial. The cube's own corner is used, so no
call has to invent coordinates.

The horizontal bounds are built by sampling the cube's XY perimeter at `k`
points per edge and taking the min and max of the projected longitudes and
latitudes. Corners alone are not enough: a projection is nonlinear, so an edge's
extreme can fall between its endpoints.

**Sampling alone is not conservative**, which Decision 6's "full containment"
requires it to be — between two samples the projected edge can still leave the
box. Measured on the fixture, the midpoint of the root cube's south edge sits
0.038 m off the straight line between that edge's projected endpoints. Small,
and not zero; on a continental file it is much larger.

So the sampled box is then **inflated by the curvature actually measured on that
node's own edges**, in the same axes the region is expressed in. For each edge,
each sample is compared against the straight interpolation between that edge's
two projected endpoints; the largest absolute longitude difference pads west and
east, the largest absolute latitude difference pads south and north. Axis-aligned
because that is what a `region` is, and a measurement rather than a guessed
constant.

Note what this does and does not promise. It bounds the deviation the samples
can see; a curve that wanders further between two adjacent samples than any
sample reveals is still missed. That residual shrinks with `k`, and the honest
statement is that the region is conservative to the resolution sampled — which
is why the child-inside-parent test below is written with the parent's own
measured padding as its tolerance rather than as an exact containment.

`k` is a new §7 row, initial value 5 — four edges, 16 distinct perimeter points
per tile. Like every §7 value it moves only on measurement, and the table is
updated when it does.

## Verification

The failure this module invites is a test that re-derives the builder's own
arithmetic and therefore agrees with it whatever it does. Three defences:

1. **An independent path to the same place.** The root tile's region must
   contain the header's corners projected directly — no cube, no stepping, no
   sampling. The builder starts from `info.cube`; the test starts from the
   header. They share no intermediate.
2. **Externally derived constants**, each carried with the derivation that
   produced it (see 88.710 m above), so the number can be checked by hand
   against the fixture rather than against the code.
3. **Invariants over the whole output**, which hold regardless of the values:
   a child's region inside its parent's, to the parent's own measured padding;
   geometric error halving with depth;
   no `content` wherever `pointCount` is 0; every content URI absolute; and the
   registry's key set exactly equal to the set of content URIs in the JSON — if
   those two drift, a tile is requested that nothing can answer, or a range is
   held that nothing will ask for.

### What the fixture can and cannot show

Measured, by reading `fixtures/autzen-root-hierarchy.bin` through
`readHierarchyPage`: **278 nodes, 0 sub-pages, 0 zero-point nodes, depths 0
through 5, and no node whose parent is missing.** Autzen's hierarchy is a single
page — which the specification permits: *"the hierarchy MAY be arranged in a
tree of pages, but SHALL always consist of at least ONE hierarchy page."*

So the fixture exercises the node path, the depth arithmetic, and the region
maths against real coordinates — and it cannot reach the page-pointer branch,
the empty-node branch, or any of the three refusals, because
the one real page we have contains no instance of any of them.

Those branches are tested against hand-built pages, and each such test says in
its own comment that it is constructed and why the fixture could not supply it.
This is stated here so that "tested against the real file" is never claimed for
a branch no real file in this repo reaches. Cutting a second fixture from a
multi-page COPC would close the gap; there is no such file available here.

### What cannot be settled here

Whether Cesium fetches an external tileset at the right moment when the
placeholder tile and the expanded tileset's root share a geometric error. The
hard gate proved the expansion path works; the timing is a traversal question a
browser has to answer. Recorded in `docs/superpowers/plans/carried-forward.md`
for sub-project 8.

## Decisions settled — do not relitigate mid-task

- **Scope is the tileset JSON alone.** PNTS encoding is a separate sub-project.
- **The token prefix is an input, not a constant here.** The module that owns
  Cesium interception owns the scheme.
- **The registry is keyed by full content URI**, because that is what the
  interceptor is handed.
- **`toWgs84(x, y, z)` is the only change to `src/crs`.**
- **`Bounds.stepTo` is used rather than reimplemented.**
- **A gap and a contradiction are both refused.** The specification represents
  empty nodes rather than omitting them, so neither has a benign reading.
