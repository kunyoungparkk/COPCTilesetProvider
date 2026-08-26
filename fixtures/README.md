# fixtures

Pinned byte slices from a real COPC file, plus synthetic layouts built in the
tests. Committed bytes only — the suite never fetches anything.

## The anchor

`autzen-*.bin` are cut from the public Autzen file recorded in
`provenance.json`. They exist so the synthetic fixtures cannot drift into
fiction: whatever we believe the format looks like has to also parse a file
somebody else wrote.

| file | what it is |
|---|---|
| `autzen-head.bin` | bytes 0-588 — the LAS header and the COPC info VLR, the single first read Decision 4 mandates |
| `autzen-vlrs.bin` | the VLR region, where the WKT record lives |
| `autzen-root-hierarchy.bin` | the root hierarchy page: 278 nodes, no sub-pages |
| `autzen-node-5-16-3-1.bin` | node `5-16-3-1`'s compressed chunk (47 points, 951 bytes) — the file's smallest, so its decoded numbers can be checked by hand |

Autzen's root page has no sub-pages, so it cannot exercise lazy hierarchy
expansion. That path is covered by synthetic fixtures built in the tests.

Its WKT is a `COMPD_CS` — a compound horizontal-plus-vertical CRS — which is
the case OVERVIEW Decision 6 refuses to hand to proj4 whole.

## The second source

Autzen is point format 7. COPC allows 6, 7 and 8, and a file is exactly one of
them, so point format is the one property no single anchor can cover —
`sofi-*.bin` are cut from the public SoFi file for format 6, which carries no
colour.

| file | what it is |
|---|---|
| `sofi-head.bin` | bytes 0-588 — the same first read, for a file whose byte 104 declares format 6 |
| `sofi-node-6-23-29-3.bin` | node `6-23-29-3`'s compressed chunk (45 points, 608 bytes) — the file's smallest |

Two slices, not four. Nothing about point format lives in a hierarchy page,
and SoFi's is 86 KB against Autzen's 8.7 KB; the VLR region is unneeded
because the format-6 tests build their transform from EPSG:32611's proj4
definition directly rather than from the file's WKT.

## Regenerating

`node fixtures/cut.mjs` re-cuts them from both source URLs, next to the slices
it writes. It needs the network, so run it by hand; CI never does.
