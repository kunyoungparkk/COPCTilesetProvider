import { describe, expect, it } from 'vitest';
import { createBudget } from '../src/budget/index.js';

// Process-wide module state, shared across every test file — see the same
// note in tests/budget-verdicts.test.ts and tests/crs-registry.test.ts.
function uniqueOrigin(): string {
  return `https://budget-atomicity-${crypto.randomUUID()}.example`;
}

describe('acquireRangeRequest is atomic', () => {
  it('leaves the byte budget untouched when the host cap is full but bytes are free', () => {
    const budget = createBudget({ rangeBodyBytes: 1_000_000, hostRequestsPerOrigin: 1 });
    const origin = uniqueOrigin();

    const first = budget.acquireRangeRequest(origin, 10);
    expect(first.verdict).toBe('admitted');
    const bytesInUseBeforeSecondCall = budget.stats().rangeBody.inUse;

    // The single host slot is already taken; bytes have plenty of room.
    const second = budget.acquireRangeRequest(origin, 10);
    expect(second.verdict).toBe('deferred');

    // A two-call design could have reserved the bytes and then discovered the
    // host slot was unavailable. This is the test that design could not pass.
    expect(budget.stats().rangeBody.inUse).toBe(bytesInUseBeforeSecondCall);
  });

  it('leaves the host slot pool untouched when bytes are full but the host cap is free', () => {
    const origin = uniqueOrigin();
    const budget = createBudget({ rangeBodyBytes: 10, hostRequestsPerOrigin: 5 });

    const first = budget.acquireRangeRequest(origin, 10); // bytes full (10/10), host 1/5
    expect(first.verdict).toBe('admitted');

    // Bytes are fully committed; the host has four spare slots, so this must
    // defer without touching the host counter.
    const second = budget.acquireRangeRequest(origin, 1);
    expect(second.verdict).toBe('deferred');

    // `stats().hostRequests` is this provider's own mirror (see budget.ts),
    // not the shared per-origin counter, so it cannot see a bug that only
    // corrupts that shared counter. A second Budget on the same origin can:
    // exactly 4 of the 5 slots should still be free.
    const probe = createBudget({ rangeBodyBytes: 1_000_000, hostRequestsPerOrigin: 5 });
    const probeVerdicts = [
      probe.acquireRangeRequest(origin, 1).verdict,
      probe.acquireRangeRequest(origin, 1).verdict,
      probe.acquireRangeRequest(origin, 1).verdict,
      probe.acquireRangeRequest(origin, 1).verdict,
    ];
    expect(probeVerdicts).toEqual(['admitted', 'admitted', 'admitted', 'admitted']);
  });
});

describe('the host slot registry is process-wide, keyed by origin', () => {
  it('shares one origin\'s capacity across two independent Budget instances', () => {
    const origin = uniqueOrigin();
    const budgetA = createBudget({ hostRequestsPerOrigin: 1, rangeBodyBytes: 1_000_000 });
    const budgetB = createBudget({ hostRequestsPerOrigin: 1, rangeBodyBytes: 1_000_000 });

    expect(budgetA.acquireRangeRequest(origin, 10).verdict).toBe('admitted');
    // The origin's single slot is taken by budgetA; a single shared counter
    // would say the same for budgetB, which is exactly what this asserts.
    expect(budgetB.acquireRangeRequest(origin, 10).verdict).toBe('deferred');
  });

  it('keeps two origins from sharing capacity with each other', () => {
    const originA = uniqueOrigin();
    const originB = uniqueOrigin();
    const budget = createBudget({ hostRequestsPerOrigin: 1, rangeBodyBytes: 1_000_000 });

    expect(budget.acquireRangeRequest(originA, 10).verdict).toBe('admitted');
    // If host slots were tracked by one counter instead of per origin, this
    // would come back 'deferred' too.
    expect(budget.acquireRangeRequest(originB, 10).verdict).toBe('admitted');
  });

  it('destroy releases only the slots the destroyed provider itself holds', () => {
    const origin = uniqueOrigin();
    const budgetA = createBudget({ hostRequestsPerOrigin: 2, rangeBodyBytes: 1_000_000 });
    const budgetB = createBudget({ hostRequestsPerOrigin: 2, rangeBodyBytes: 1_000_000 });

    expect(budgetA.acquireRangeRequest(origin, 10).verdict).toBe('admitted'); // 1/2
    expect(budgetB.acquireRangeRequest(origin, 10).verdict).toBe('admitted'); // 2/2
    expect(budgetA.acquireRangeRequest(origin, 10).verdict).toBe('deferred'); // full

    budgetA.destroy(); // frees only budgetA's one slot: 1/2

    expect(budgetB.acquireRangeRequest(origin, 10).verdict).toBe('admitted'); // 2/2 again
    expect(budgetB.acquireRangeRequest(origin, 10).verdict).toBe('deferred'); // full again, still budgetB's own doing
  });
});
