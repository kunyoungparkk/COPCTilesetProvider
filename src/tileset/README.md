# tileset

Maps the COPC octree onto a synthetic 3D Tiles document, plus the registry that resolves each content-bearing tile's opaque URI back to its byte range.

`measureRootGeometricError(header, transform)` is the module's other export. Decision 6 asks for the root's *measured* metre span, which only the LAS header carries — `info.cube` is padded — so it is measured from the header once and passed back in as `TilesetContext.rootGeometricError`, the same value for every page of a file.

`buildTileset` serves the file's root page and every sub-page alike, so a hierarchy tile expanding into an external tileset is another call rather than another code path. It is pure and synchronous: Blob URLs, codec installation and `Resource` interception belong to the provider, and the URI scheme is the caller's because the caller owns the interception.

Two limits worth knowing. A node's region is conservative to the resolution sampled — the perimeter is sampled per edge, then the whole box is widened by the largest curvature measured across those edges, so a projection that leaves the box between two adjacent samples is still missed. And a page whose entries skip a level gets skeleton tiles, counted in `synthesizedAncestors`; a page that names a depth no COPC octree reaches, an entry outside its own subtree, or a key claimed as both a node and a page, is refused instead.

OVERVIEW §3, Decision 1, Decision 2 and Decision 6.
