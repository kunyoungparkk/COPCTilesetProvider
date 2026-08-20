/**
 * The proj4 definition of every coordinate system this realm can transform.
 *
 * Module state, so a Worker gets its own empty-but-for-4326 copy — see this
 * directory's README for what has to cross that boundary instead.
 *
 * Decision 6 seeds it with EPSG:4326 alone. A partial built-in table would
 * invite the question of why one system is present and another absent; one
 * rule — "if it is not 4326, register it" — has no such edge.
 */
const definitions = new Map<number, string>([[4326, '+proj=longlat +datum=WGS84 +no_defs']]);

/**
 * Teaches this process one coordinate system.
 *
 * The definition's accuracy is the caller's to vouch for; Decision 6 is
 * explicit that this library applies what it is given rather than judging it.
 * Registering a code twice replaces the earlier definition, so a caller can
 * correct one without restarting.
 */
export function registerCrs(code: number, definition: string): void {
  definitions.set(code, definition);
}

/** The registered definition for a code, or `undefined` if nobody supplied one. */
export function definitionFor(code: number): string | undefined {
  return definitions.get(code);
}
