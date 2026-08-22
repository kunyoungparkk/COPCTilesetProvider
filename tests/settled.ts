/**
 * Whether a promise has settled yet, and to what.
 *
 * Shared by the pool's two test files because a terminal path that stops
 * settling is this module's easiest defect to write and its worst to read:
 * awaiting such a promise directly fails as Vitest's five-second per-test
 * timeout, with no diff and no line to look at.
 */
export type Settlement =
  | { readonly state: 'pending' }
  | { readonly state: 'fulfilled'; readonly value: unknown }
  | { readonly state: 'rejected'; readonly reason: unknown };

/**
 * Reports whether `promise` has already settled, and to what — waiting only
 * one microtask turn rather than however long the promise actually takes
 * (or forever, if a defect means it never settles). A terminal path that
 * stops settling then fails this as an immediate `{ state: 'pending' }`
 * mismatch, not Vitest's five-second per-test timeout.
 */
export async function settleWith(promise: Promise<unknown>): Promise<Settlement> {
  let settlement: Settlement = { state: 'pending' };
  promise.then(
    (value) => {
      settlement = { state: 'fulfilled', value };
    },
    (reason) => {
      settlement = { state: 'rejected', reason };
    },
  );
  await Promise.resolve(); // one microtask turn — enough for the handlers above to run if `promise` was already settled.
  return settlement;
}
