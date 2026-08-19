# worker

The off-main-thread pipeline that turns compressed LAZ bytes into a PNTS tile: decode, CRS transform, then encode. Encodes LAS attributes into the PNTS batch table so GPU styling and picking can reference them.

OVERVIEW §3, Decisions 3 and 6.
