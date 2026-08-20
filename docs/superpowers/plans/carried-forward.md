# Carried forward

Obligations a finished sub-project handed to a later one. Each names the plan
that must carry it, so it is picked up when that plan is written rather than
rediscovered. Delete an entry when the work lands.

## For the tileset / Worker sub-project

- **Reject `+nadgrids` and `proj4.defs`-alias definitions at the Worker init
  seam, with a typed error.** Both depend on realm-global proj4 state that the
  posted definition string only refers to, so a Worker missing it returns
  `[NaN, NaN]` with nothing but a console line (measured, proj4 2.21), or throws
  a value that is not an `Error`. `src/crs/README.md` records the limitation;
  this is the check that makes it loud. It belongs at the seam because that is
  where a Worker init message is validated and where a typed error can still
  reach the caller's `fromUrl` promise.
- **Call `resolveCrsDefinition` once, on the main thread, at open time**, and
  put its answer in the Worker's init message. It throws `CrsNotRegisteredError`
  and `CrsCodeNotFoundError`, which have to surface where `fromUrl` can reject;
  the same throw inside a Worker becomes an opaque `messageerror`.

- **Check when Cesium fetches an external tileset whose placeholder shares its
  geometric error.** The synthetic tileset gives a page-pointer tile and the
  root of the tileset it expands into the same key, and therefore the same
  geometric error. Whether traversal then fetches the expansion at the right
  moment is a browser question; the hard gate proved the expansion path works,
  not its timing.

## For whichever sub-project first ships a root README

- **State the ellipsoidal-height (HAE) limitation.** OVERVIEW §6 requires it and
  no root `README.md` exists yet. `src/crs/ecef.ts` and `src/crs/README.md`
  carry the fact; the user-facing page does not.

## Unscheduled

- **The PDAL ground-truth comparison Decision 6 specifies has not been run.**
  PDAL cannot be installed on this machine, so the CRS sub-project verified what
  it could without an outside authority and recorded the gap. Nothing anywhere
  claims otherwise; keep it that way until it is actually run.
