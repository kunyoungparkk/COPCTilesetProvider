/**
 * The file's horizontal coordinate system: its EPSG code, the EPSG code of
 * the datum it sits on, and the WKT of that system alone.
 *
 * Decision 6 names the code in every CRS error, so the caller knows which
 * definition to look up. The pinned Autzen file shows why finding it takes
 * care: it carries ten AUTHORITY nodes, and the horizontal one is neither the
 * first (a spheroid) nor the last (a vertical datum). The rule is therefore
 * structural — the authority that is a *direct child* of the horizontal
 * system — which needs bracket depth, not pattern matching. The vertical
 * system is a separate question, asked by `findVerticalEpsgCode` off the same
 * walk.
 *
 * The WKT is the `PROJCS` node when there is one, else the `GEOGCS` node —
 * cut out of a compound, so a vertical system never reaches proj4. Measured
 * on proj4 2.21: every compound WKT1 and WKT2 tried throws, Autzen's
 * included, and the horizontal node alone projects Autzen exactly as the
 * hand-written definition it replaced did.
 *
 * Returns `null` when there is no such code; the caller decides what that means.
 */
export function findHorizontalCrs(
  wkt: string,
): { code: number; datumCode: number | null; wkt: string } | null {
  const { found, spans, sawProjected } = scanAuthorities(wkt);
  const datumCode = found.get('DATUM') ?? null;

  // A file that has a projected system has its coordinates in that system, so
  // its code is the answer whenever it names one.
  const projected = found.get('PROJCS');
  const projectedWkt = spans.get('PROJCS');
  if (projected !== undefined && projectedWkt !== undefined) {
    return { code: projected, datumCode, wkt: projectedWkt };
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
  const geographic = found.get('GEOGCS');
  const geographicWkt = spans.get('GEOGCS');
  if (geographic === undefined || geographicWkt === undefined) {
    return null;
  }
  return { code: geographic, datumCode, wkt: geographicWkt };
}

/**
 * Finds the EPSG code of the file's vertical coordinate system.
 *
 * Unlike the horizontal one this answer never chooses a transform — nothing
 * here resolves a vertical CRS. It exists so `fromUrl` can tell a file that
 * measures height from a geoid apart from one that does not, and warn when the
 * caller has given it no `geoidHeight` to correct with.
 *
 * Returns `null` when the file names no vertical system, which the caller
 * reads as "nothing to warn about".
 */
export function findVerticalEpsgCode(wkt: string): number | null {
  return scanAuthorities(wkt).found.get('VERT_CS') ?? null;
}

/**
 * Metres per unit of the file's heights, as its vertical system states it.
 *
 * The horizontal definition cannot answer this: its linear unit is the unit
 * of x and y, and a file is free to measure height in another. Measured on
 * the public hobu-lidar bucket, autzen-2023 is in metres across and US survey
 * feet up, so heights scaled by the horizontal unit come out 3.28 times too
 * tall.
 *
 * Returns `null` when the file names no vertical system, or names one whose
 * `UNIT` is missing or is not a positive number. The caller reads that as
 * "the file did not say", and falls back to the horizontal definition's unit.
 */
export function findVerticalUnit(wkt: string): number | null {
  return scanAuthorities(wkt).verticalUnit;
}

/**
 * Every EPSG code the WKT carries, keyed by the keyword its AUTHORITY node
 * sits directly inside — `PROJCS`, `GEOGCS`, `DATUM`, `VERT_CS`, and whatever
 * else the file names — the text of its horizontal system's nodes, and the
 * linear unit of its vertical system.
 *
 * Keyed by parent rather than collected in order because a code's meaning is
 * its position: Autzen's WKT holds ten AUTHORITY nodes, and 2992, 4269, 6360
 * and 5103 are all in there saying different things. The horizontal reader and
 * the vertical one are two questions asked of one walk.
 */
function scanAuthorities(wkt: string): {
  found: Map<string, number>;
  spans: Map<string, string>;
  sawProjected: boolean;
  verticalUnit: number | null;
} {
  // Keyed by the keyword each authority sits directly inside, so the horizontal
  // system's own code is distinguishable from the ones its parts carry.
  const found = new Map<string, number>();
  // The text of the first PROJCS and the first GEOGCS node to close, keyword
  // to closing bracket. A GEOGCS nested in a PROJCS closes first, which is
  // harmless: it is only read back when the file has no PROJCS.
  const spans = new Map<string, string>();
  const open: { keyword: string; start: number; body: number }[] = [];
  let quoted = false;
  // Tracked separately from `found`, because "the file has a projected system"
  // and "that system names an EPSG code" are different facts with different
  // answers — see how findHorizontalCrs resolves the two.
  let sawProjected = false;
  let verticalUnit: number | null = null;

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
      const start = keywordStart(wkt, i);
      const keyword = wkt.slice(start, i).trimEnd();
      sawProjected ||= keyword === 'PROJCS';
      open.push({ keyword, start, body: i + 1 });
      continue;
    }
    if (character !== ']') {
      continue;
    }

    const node = open.pop();
    if (node === undefined) {
      continue;
    }
    if ((node.keyword === 'PROJCS' || node.keyword === 'GEOGCS') && !spans.has(node.keyword)) {
      spans.set(node.keyword, wkt.slice(node.start, i + 1));
    }

    // Direct child only, for the reason an authority is: a compound WKT holds
    // a UNIT under its projected system, another under the geographic one
    // inside that, and each means a different thing.
    const parent = open[open.length - 1];
    if (node.keyword === 'UNIT' && parent?.keyword === 'VERT_CS') {
      verticalUnit = unitFactor(wkt.slice(node.body, i));
    }
    if (node.keyword !== 'AUTHORITY') {
      continue;
    }

    // `found` is keyed by the enclosing keyword rather than by the node, so a
    // second authority under a repeated keyword replaces the first. The pinned
    // file reaches this three times through its UNIT nodes, invisibly — only
    // PROJCS, GEOGCS, and VERT_CS are ever read back. Later wins where it does
    // show, and that is pinned, so the tie-break is a choice and not this
    // loop's shape.
    if (parent === undefined) {
      continue;
    }

    const code = epsgCode(wkt.slice(node.body, i));
    if (code !== null) {
      found.set(parent.keyword, code);
    }
  }

  return { found, spans, sawProjected, verticalUnit };
}

/**
 * Where the bare keyword preceding a bracket starts, e.g. the `A` of
 * `AUTHORITY[`. The keyword is the text from there to the bracket, less any
 * whitespace before it.
 */
function keywordStart(wkt: string, bracket: number): number {
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
  return start;
}

const UNIT_BODY = /^\s*"[^"]*"\s*,\s*([^,\s]+)/;

/**
 * Reads the conversion factor out of a unit node's body, `"foot",0.3048` and
 * whatever follows it, or `null` if it is not a positive number.
 */
function unitFactor(body: string): number | null {
  const factor = Number(UNIT_BODY.exec(body)?.[1]);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

const EPSG_BODY = /^\s*"?EPSG"?\s*,\s*"?(\d+)"?\s*$/;

/** Reads `"EPSG","2992"` out of an authority node's body, or `null` if it is not EPSG. */
function epsgCode(body: string): number | null {
  const match = EPSG_BODY.exec(body);
  const digits = match?.[1];
  return digits === undefined ? null : Number(digits);
}
