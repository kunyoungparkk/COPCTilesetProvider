/**
 * The base class for every error this library throws.
 *
 * Errors are part of the public API (OVERVIEW §3, Decision 6), so they carry
 * two things: `code`, a stable identifier callers branch on, and a message
 * that names the change which fixes the problem. Messages may be reworded;
 * codes may not.
 */
export abstract class CopcTilesetError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Subclass name rather than "Error", so stack traces and logs identify
    // the failure without anyone having to read `code`.
    this.name = new.target.name;
  }
}
