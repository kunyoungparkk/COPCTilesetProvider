import { describe, expect, it } from 'vitest';
import { createBudget } from '../src/budget/index.js';

// The host registry (src/budget/host-registry.ts) is process-wide module
// state, shared with every other test file however vitest is isolating them —
// see tests/crs-registry.test.ts for the same pattern with the CRS registry.
// A fresh, unique origin per test keeps these tests independent of that state.
function uniqueOrigin(): string {
  return `https://budget-verdicts-${crypto.randomUUID()}.example`;
}

describe('acquireDecodeJob', () => {
  it('admits jobs up to the configured capacity and defers beyond it', () => {
    const budget = createBudget({ decodeJobs: 2 });

    expect(budget.acquireDecodeJob().verdict).toBe('admitted');
    expect(budget.acquireDecodeJob().verdict).toBe('admitted');
    expect(budget.acquireDecodeJob().verdict).toBe('deferred');
  });

  it('rejects as over-capacity when the whole budget has no room, not deferred', () => {
    const budget = createBudget({ decodeJobs: 0 });

    expect(budget.acquireDecodeJob()).toEqual({ verdict: 'rejected', reason: 'over-capacity' });
  });
});

describe('acquireRangeRequest — the byte budget', () => {
  it('draws the line between a recoverable and a permanent refusal at the budget total', () => {
    const budget = createBudget({ rangeBodyBytes: 100, hostRequestsPerOrigin: 100 });
    const origin = uniqueOrigin();

    // Fits, and there happens to be room: admitted, using all 100 bytes.
    const first = budget.acquireRangeRequest(origin, 100);
    expect(first.verdict).toBe('admitted');

    // Fits the whole budget in principle, but no room right now: deferred,
    // because a later frame — once something releases — could say yes.
    const second = budget.acquireRangeRequest(origin, 1);
    expect(second).toEqual({ verdict: 'deferred' });
    // The host cap (100) was never in play for this call, so this deferral
    // is attributed to bytes alone.
    expect(budget.stats().rangeBody.deferred).toBe(1);
    expect(budget.stats().hostRequests.deferred).toBe(0);

    // Bigger than the whole budget: no amount of waiting ever frees enough,
    // so this is rejected outright rather than deferred.
    const third = budget.acquireRangeRequest(origin, 101);
    expect(third).toEqual({ verdict: 'rejected', reason: 'over-capacity' });
  });
});

describe('acquireRangeRequest — the host slot budget', () => {
  it('admits host requests up to the per-origin capacity and defers beyond it', () => {
    const budget = createBudget({ hostRequestsPerOrigin: 2, rangeBodyBytes: 1_000_000 });
    const origin = uniqueOrigin();

    expect(budget.acquireRangeRequest(origin, 10).verdict).toBe('admitted');
    expect(budget.acquireRangeRequest(origin, 10).verdict).toBe('admitted');
    expect(budget.acquireRangeRequest(origin, 10).verdict).toBe('deferred');
  });

  it('rejects as over-capacity when the origin has no host capacity at all', () => {
    const budget = createBudget({ hostRequestsPerOrigin: 0, rangeBodyBytes: 1_000_000 });
    const origin = uniqueOrigin();

    expect(budget.acquireRangeRequest(origin, 10)).toEqual({
      verdict: 'rejected',
      reason: 'over-capacity',
    });
    // 10 bytes was never close to the 1,000,000-byte budget, so this
    // rejection is attributed to the host side alone.
    expect(budget.stats().rangeBody.rejected).toBe(0);
    expect(budget.stats().hostRequests.rejected).toBe(1);
  });
});

describe('stats() attributes each verdict to the side that actually caused it', () => {
  it('records deferred/rejected on whichever of bytes or the host slot actually lacked it', () => {
    const budget = createBudget({ rangeBodyBytes: 100, hostRequestsPerOrigin: 1 });
    const origin = uniqueOrigin();

    // Admitted: takes the origin's only host slot, 10 of 100 bytes.
    expect(budget.acquireRangeRequest(origin, 10).verdict).toBe('admitted');
    expect(budget.stats().rangeBody.admitted).toBe(1);
    expect(budget.stats().hostRequests.admitted).toBe(1);

    // Host-caused deferral: bytes have 90 of 100 still free, but the
    // origin's single host slot is already taken.
    expect(budget.acquireRangeRequest(origin, 10).verdict).toBe('deferred');
    expect(budget.stats().rangeBody.deferred).toBe(0);
    expect(budget.stats().hostRequests.deferred).toBe(1);

    // Byte-caused rejection: 1000 bytes is bigger than the whole 100-byte
    // budget, but the host side never lacked capacity for its 1 slot.
    expect(budget.acquireRangeRequest(origin, 1_000)).toEqual({
      verdict: 'rejected',
      reason: 'over-capacity',
    });
    expect(budget.stats().rangeBody.rejected).toBe(1);
    expect(budget.stats().hostRequests.rejected).toBe(0);
  });
});

describe('stats() records both sides when both are legitimately at fault', () => {
  it('records deferred on both rows when bytes and the host slot are both merely short of room', () => {
    const budget = createBudget({ rangeBodyBytes: 10, hostRequestsPerOrigin: 1 });
    const origin = uniqueOrigin();

    // Admitted: uses all 10 bytes and the origin's only host slot.
    expect(budget.acquireRangeRequest(origin, 10).verdict).toBe('admitted');

    // Neither side has room for even 1 more byte or 1 more slot: this is not
    // attributable to only one side, so attribution must not be exclusive —
    // both rows record the deferral.
    expect(budget.acquireRangeRequest(origin, 1).verdict).toBe('deferred');
    expect(budget.stats().rangeBody.deferred).toBe(1);
    expect(budget.stats().hostRequests.deferred).toBe(1);
  });

  it('records rejected on both rows when bytes and the host slot are both over capacity', () => {
    const budget = createBudget({ rangeBodyBytes: 10, hostRequestsPerOrigin: 0 });
    const origin = uniqueOrigin();

    // 20 bytes exceeds the 10-byte budget, and the origin's host cap of 0
    // cannot admit even one request: both sides are over capacity at once,
    // so both rows must record the rejection.
    expect(budget.acquireRangeRequest(origin, 20)).toEqual({
      verdict: 'rejected',
      reason: 'over-capacity',
    });
    expect(budget.stats().rangeBody.rejected).toBe(1);
    expect(budget.stats().hostRequests.rejected).toBe(1);
  });
});

describe('a row can legitimately record nothing for a call it took part in', () => {
  it('leaves rangeBody untouched by a rejection the host side alone caused', () => {
    const budget = createBudget({ rangeBodyBytes: 1_000_000, hostRequestsPerOrigin: 0 });
    const origin = uniqueOrigin();

    // Bytes are nowhere near their budget; only the host side (capacity 0)
    // is over capacity. rangeBody took part in this call — it is one half
    // of the same acquireRangeRequest — but attribution means it is not
    // this row's rejection to record, so it stays exactly as it started.
    expect(budget.acquireRangeRequest(origin, 10)).toEqual({
      verdict: 'rejected',
      reason: 'over-capacity',
    });

    expect(budget.stats().rangeBody).toEqual({ admitted: 0, deferred: 0, rejected: 0, inUse: 0, peak: 0 });
    expect(budget.stats().hostRequests.rejected).toBe(1);
  });
});

describe('rejection has exactly two causes', () => {
  it('rejects every acquire call once the budget is destroyed, even one that would otherwise fit', () => {
    const budget = createBudget({ decodeJobs: 4, rangeBodyBytes: 1_000_000, hostRequestsPerOrigin: 4 });
    budget.destroy();

    expect(budget.acquireDecodeJob()).toEqual({ verdict: 'rejected', reason: 'destroyed' });
    expect(budget.acquireRangeRequest(uniqueOrigin(), 1)).toEqual({
      verdict: 'rejected',
      reason: 'destroyed',
    });
    // Unlike over-capacity, a destroyed rejection is not a fact about either
    // side individually, so both rows record it.
    expect(budget.stats().rangeBody.rejected).toBe(1);
    expect(budget.stats().hostRequests.rejected).toBe(1);
  });
});
