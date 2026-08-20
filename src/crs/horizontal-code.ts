/**
 * Finds the EPSG code of the file's horizontal coordinate system.
 *
 * Decision 6 extracts a code and resolves it against a registry rather than
 * handing whole WKT to proj4, because compound systems and dialects go quietly
 * wrong that way. The pinned Autzen file shows how quietly: it carries ten
 * AUTHORITY nodes, and the horizontal one is neither the first (a spheroid)
 * nor the last (a vertical datum).
 *
 * The rule is therefore structural — the authority that is a *direct child* of
 * the horizontal system — which needs bracket depth, not pattern matching.
 * OVERVIEW §6 keeps heights ellipsoidal, so the vertical system is never
 * consulted.
 *
 * Returns `null` when there is no such code; the caller decides what that means.
 */
export function findHorizontalEpsgCode(wkt: string): number | null {
  // Keyed by the keyword each authority sits directly inside, so the horizontal
  // system's own code is distinguishable from the ones its parts carry.
  const found = new Map<string, number>();
  const open: { keyword: string; body: number }[] = [];
  let quoted = false;
  // Tracked separately from `found`, because "the file has a projected system"
  // and "that system names an EPSG code" are different facts with different
  // answers — see the resolution below.
  let sawProjected = false;

  for (let i = 0; i < wkt.length; i++) {
    const character = wkt[i];

    // A name may contain anything, brackets included, so quoted spans are
    // skipped rather than scanned.
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }

    if (character === '[') {
      const keyword = keywordBefore(wkt, i);
      sawProjected ||= keyword === 'PROJCS';
      open.push({ keyword, body: i + 1 });
      continue;
    }
    if (character !== ']') {
      continue;
    }

    const node = open.pop();
    if (node === undefined || node.keyword !== 'AUTHORITY') {
      continue;
    }

    // `found` is keyed by the enclosing keyword rather than by the node, so a
    // second authority under a repeated keyword replaces the first. The pinned
    // file reaches this three times through its UNIT nodes, invisibly — only
    // PROJCS and GEOGCS are ever read back. Later wins where it does show, and
    // that is pinned, so the tie-break is a choice and not this loop's shape.
    const parent = open[open.length - 1];
    if (parent === undefined) {
      continue;
    }

    const code = epsgCode(wkt.slice(node.body, i));
    if (code !== null) {
      found.set(parent.keyword, code);
    }
  }

  // A file that has a projected system has its coordinates in that system, so
  // its code is the answer whenever it names one.
  const projected = found.get('PROJCS');
  if (projected !== undefined) {
    return projected;
  }

  // When it names none — an ESRI authority, say — the answer is nothing. The
  // geographic system nested inside it describes the datum it was projected
  // from, not where the points are: returning 4269 for Autzen would hand a
  // geographic transform an easting of 635577 feet to read as degrees. Null
  // reaches the caller as a typed error naming what went unresolved.
  if (sawProjected) {
    return null;
  }

  // With no projected system at all, the geographic one genuinely is horizontal.
  return found.get('GEOGCS') ?? null;
}

/** The bare keyword preceding a bracket, e.g. `AUTHORITY` in `AUTHORITY[`. */
function keywordBefore(wkt: string, bracket: number): string {
  // Formatted WKT breaks the line between a keyword and its bracket. Reading
  // that as a nameless node would report a file that names its system perfectly
  // well as naming none, and send the user off to rewrite a file that is fine.
  let end = bracket;
  while (end > 0 && /\s/.test(wkt[end - 1] ?? '')) {
    end--;
  }

  let start = end;
  while (start > 0 && /[A-Z_]/.test(wkt[start - 1] ?? '')) {
    start--;
  }
  return wkt.slice(start, end);
}

const EPSG_BODY = /^\s*"?EPSG"?\s*,\s*"?(\d+)"?\s*$/;

/** Reads `"EPSG","2992"` out of an authority node's body, or `null` if it is not EPSG. */
function epsgCode(body: string): number | null {
  const match = EPSG_BODY.exec(body);
  const digits = match?.[1];
  return digits === undefined ? null : Number(digits);
}
