import { describe, expect, it } from 'vitest';
import { createBudget } from '../src/budget/index.js';

// Process-wide module state, shared across every test file — see the same
// note in tests/budget-verdicts.test.ts and tests/crs-registry.test.ts.
function uniqueOrigin(): string {
  return `https://budget-stats-${crypto.randomUUID()}.example`;
}

describe('stats()', () => {
  it('counts each verdict a resource actually received', () => {
    const budget = createBudget({ decodeJobs: 1 });

    const admitted = budget.acquireDecodeJob();
    const deferred = budget.acquireDecodeJob();
    expect(admitted.verdict).toBe('admitted');
    expect(deferred.verdict).toBe('deferred');

    const stats = budget.stats().decode;
    expect(stats.admitted).toBe(1);
    expect(stats.deferred).toBe(1);
    expect(stats.rejected).toBe(0);
  });

  it('records a peak that a later release does not erase', () => {
    const budget = createBudget({ decodeJobs: 5 });

    const first = budget.acquireDecodeJob();
    const second = budget.acquireDecodeJob();
    if (first.verdict !== 'admitted' || second.verdict !== 'admitted') {
      throw new Error('expected both admissions');
    }
    expect(budget.stats().decode.inUse).toBe(2);
    expect(budget.stats().decode.peak).toBe(2);

    first.lease.release();

    // inUse drops back to what is still held, but the high-water mark stands.
    expect(budget.stats().decode.inUse).toBe(1);
    expect(budget.stats().decode.peak).toBe(2);
  });

  it('keeps peak at the highest overlap, not the count of acquisitions', () => {
    const budget = createBudget({ decodeJobs: 3 });

    // Acquired and released one at a time: usage never overlaps, so peak
    // should stay at 1 no matter how many times this repeats.
    for (let i = 0; i < 3; i += 1) {
      const job = budget.acquireDecodeJob();
      if (job.verdict !== 'admitted') throw new Error('expected admission');
      job.lease.release();
    }

    const stats = budget.stats().decode;
    expect(stats.inUse).toBe(0);
    expect(stats.peak).toBe(1);
  });

  it('mirrors a real host-slot hold in hostRequests.inUse and hostRequests.peak, not just zero', () => {
    const budget = createBudget({ rangeBodyBytes: 100, hostRequestsPerOrigin: 5 });
    const origin = uniqueOrigin();

    const admission = budget.acquireRangeRequest(origin, 40);
    if (admission.verdict !== 'admitted') throw new Error('expected admission');

    // Both fields are supposed to be honest reporting, not always-zero
    // placeholders — pinned non-zero while the lease is held.
    expect(budget.stats().hostRequests.inUse).toBe(1);
    expect(budget.stats().hostRequests.peak).toBe(1);

    admission.lease.release();

    // inUse returns; peak, being a high-water mark, does not.
    expect(budget.stats().hostRequests.inUse).toBe(0);
    expect(budget.stats().hostRequests.peak).toBe(1);
  });
});
