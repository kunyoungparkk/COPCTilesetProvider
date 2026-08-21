import { describe, expect, it } from 'vitest';
import { CopcTilesetError, LeaseAlreadyReleasedError } from '../src/errors/index.js';
import { createBudget } from '../src/budget/index.js';

// Process-wide module state, shared across every test file — see the same
// note in tests/budget-verdicts.test.ts and tests/crs-registry.test.ts.
function uniqueOrigin(): string {
  return `https://budget-lease-${crypto.randomUUID()}.example`;
}

// Decision 5 names four ways a reservation's lifetime can end: success,
// failure, cancellation, destroy. Each must return the reservation exactly
// once — inUse back to zero, and a further release() an observable error
// rather than a silent no-op.
describe('every exit path returns a reservation exactly once', () => {
  it('on success: the caller releases after the work completes', () => {
    const budget = createBudget({ decodeJobs: 1 });
    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    admission.lease.release();

    expect(budget.stats().decode.inUse).toBe(0);
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);
  });

  it('on failure: the caller releases from its catch/finally', () => {
    const budget = createBudget({ decodeJobs: 1 });
    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    try {
      throw new Error('decode job failed');
    } catch {
      admission.lease.release();
    }

    expect(budget.stats().decode.inUse).toBe(0);
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);
  });

  it('on cancellation: the caller releases from an abort handler', () => {
    const budget = createBudget({ decodeJobs: 1 });
    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => admission.lease.release());
    controller.abort();

    expect(budget.stats().decode.inUse).toBe(0);
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);
  });

  it('on destroy: the budget frees it immediately, and still accepts the adopted lease\'s one release', () => {
    const budget = createBudget({ decodeJobs: 1 });
    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    budget.destroy();
    // Freed at destroy time — the holder does not have to release for this
    // to be true, and has not yet called release() at all here.
    expect(budget.stats().decode.inUse).toBe(0);

    // The holder did nothing wrong, so its one release is still honoured.
    expect(() => admission.lease.release()).not.toThrow();
    // That accepted call must not free the resource a second time — if it
    // did, inUse would go negative here, since destroy already returned it
    // to zero before this call ran.
    expect(budget.stats().decode.inUse).toBe(0);
    // A second release — from this same lease, after it was already adopted
    // and consumed — is exactly the double-release the invariant forbids.
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);
  });

  it('destroy() is safe to call again: the second call has nothing left to free', () => {
    const budget = createBudget({ decodeJobs: 1 });
    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    budget.destroy();

    expect(() => budget.destroy()).not.toThrow();
    // The second destroy() must not have freed the still-outstanding lease a
    // second time — if it had, inUse would go negative here.
    expect(budget.stats().decode.inUse).toBe(0);
    expect(() => admission.lease.release()).not.toThrow();
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);
  });
});

describe('a composite range-request lease releases both halves exactly once', () => {
  it('frees bytes and the host slot together, and a second release throws without freeing again', () => {
    const budget = createBudget({ rangeBodyBytes: 100, hostRequestsPerOrigin: 5 });
    const origin = uniqueOrigin();
    const admission = budget.acquireRangeRequest(origin, 40);
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    admission.lease.release();

    expect(budget.stats().rangeBody.inUse).toBe(0);
    expect(budget.stats().hostRequests.inUse).toBe(0);
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);

    // The throw itself must not free anything a second time: if it did,
    // inUse would go negative here rather than staying at what the first
    // release already returned it to.
    expect(budget.stats().rangeBody.inUse).toBe(0);
    expect(budget.stats().hostRequests.inUse).toBe(0);
  });

  it('destroying with a range-request lease outstanding frees both halves once', () => {
    const budget = createBudget({ rangeBodyBytes: 100, hostRequestsPerOrigin: 5 });
    const origin = uniqueOrigin();
    const admission = budget.acquireRangeRequest(origin, 40);
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    budget.destroy();

    expect(budget.stats().rangeBody.inUse).toBe(0);
    expect(budget.stats().hostRequests.inUse).toBe(0);
    expect(() => admission.lease.release()).not.toThrow();
    // Neither counter should have been freed a second time by that accepted
    // call — both must still read zero, not negative.
    expect(budget.stats().rangeBody.inUse).toBe(0);
    expect(budget.stats().hostRequests.inUse).toBe(0);
    expect(() => admission.lease.release()).toThrow(LeaseAlreadyReleasedError);
  });
});

describe('LeaseAlreadyReleasedError', () => {
  it('carries a stable code and the base type', () => {
    const budget = createBudget({ decodeJobs: 1 });
    const admission = budget.acquireDecodeJob();
    if (admission.verdict !== 'admitted') throw new Error('expected admission');
    admission.lease.release();

    let caught: unknown;
    try {
      admission.lease.release();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CopcTilesetError);
    expect(caught).toBeInstanceOf(LeaseAlreadyReleasedError);
    expect((caught as LeaseAlreadyReleasedError).code).toBe('lease-already-released');
    expect((caught as LeaseAlreadyReleasedError).name).toBe('LeaseAlreadyReleasedError');
  });
});
