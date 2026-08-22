/**
 * Whether a promise has settled yet, and to what.
 *
 * Shared by the pool's two test files because a terminal path that stops
 * settling is this module's easiest defect to write and its worst to read:
 * awaiting such a promise directly fails as Vitest's five-second per-test
 * timeout, with no diff and no line to look at.
 */
/**
 * Enough turns for the hops an `async` function's own `await`s cost, with
 * room to spare. Raising it is free; it never waits on anything real.
 */
const MICROTASK_TURNS = 16;

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
  // Several microtask turns, not one, and deliberately not a macrotask.
  //
  // One turn is enough only for a promise already settled at the call. A
  // promise an `async` function returns settles over several hops, and a
  // single `await Promise.resolve()` reports it `'pending'` when it is a
  // turn or two from resolving.
  //
  // Yielding to the macrotask queue instead — `setImmediate` — would drain
  // every hop, but it also lets Node's unhandled-rejection check run, and a
  // caller that rejects a promise on one line and observes it a few lines
  // later would be reported as leaving a rejection unhandled. Staying inside
  // the microtask queue keeps that check from firing between the rejection
  // and the handler this function has already attached.
  //
  // A promise waiting on a timer or on real I/O still reports `'pending'`,
  // which is the distinction this helper exists to make.
  for (let turn = 0; turn < MICROTASK_TURNS; turn++) {
    await Promise.resolve();
  }
  return settlement;
}
