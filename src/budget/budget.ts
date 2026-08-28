import { Counter, type BudgetCounterStats } from './counter.js';
import { counterForOrigin } from './host-registry.js';
import { createLease, type Lease, type OutstandingLease } from './lease.js';

// OVERVIEW §7 initial values. Changing one requires a measurement and an
// update to that table.
const DEFAULT_RANGE_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_DECODE_JOBS = 8; // worker pool of 4, times 2
const DEFAULT_HOST_REQUESTS_PER_ORIGIN = 6;

/**
 * Why an acquisition was rejected outright rather than deferred.
 *
 * `'over-capacity'`: the request is bigger than the budget's whole capacity,
 * so no amount of waiting would ever free enough room. `'destroyed'`: the
 * budget itself is gone (`Budget.destroy` was called).
 */
export type RejectionReason = 'over-capacity' | 'destroyed';

/** The outcome of one acquire call: admitted (with the `Lease` to release), deferred until a later call might succeed, or rejected for good. */
export type Admission =
  | { readonly verdict: 'admitted'; readonly lease: Lease }
  | { readonly verdict: 'deferred' }
  | { readonly verdict: 'rejected'; readonly reason: RejectionReason };

/** The three §7 values this budget enforces. Constructor options, not public API. */
export interface BudgetLimits {
  readonly rangeBodyBytes: number;
  readonly decodeJobs: number;
  readonly hostRequestsPerOrigin: number;
}

/**
 * `acquireRangeRequest` attributes each deferred or rejected verdict only to
 * the side that actually caused it (see `hostRequests` below), so
 * `rangeBody`'s and `hostRequests`' `admitted + deferred + rejected` will not
 * generally equal the number of `acquireRangeRequest` calls made — each row
 * is silent for whichever calls the other side alone was responsible for, so
 * no §7 refusal ratio can be read off a single row.
 */
export interface BudgetStats {
  readonly rangeBody: BudgetCounterStats;
  readonly decode: BudgetCounterStats;
  /**
   * This provider's own view of the host-slot budget, not the shared
   * per-origin state that actually gates admission (see `host-registry.ts`).
   *
   * `admitted` always mirrors `rangeBody.admitted`: a Range request commits
   * both sides together or neither. `deferred` and `rejected` are recorded
   * here only when the host side was itself the one lacking room or capacity
   * for that call — except when the whole budget has been destroyed, which
   * rejects both rows unconditionally, since destruction is not a fact about
   * either side individually.
   *
   * None of these counts HTTP requests. A slot is taken per tile read, before
   * `createCoalescingReader` merges that read with the others admitted in the
   * same frame, so several admissions here can share one request — see
   * `host-registry.ts` for what that means for §7's cap. `RangeStats` is where
   * the requests themselves are counted.
   *
   * `inUse` and `peak` are summed across every origin this provider has
   * touched, which can misreport §7's per-origin host-cap number in either
   * direction: a provider that itself uses more than one origin will see
   * this over-report the true peak on any single origin (three origins with
   * one slot each gives a mirror peak of 3, though each origin's true
   * high-water mark was 1), while a provider that shares one origin with
   * another provider will see this under-report that origin's true peak
   * instead (the origin's true concurrent load is the sum of every
   * provider's slots, but each provider's own mirror counts only its own
   * share).
   */
  readonly hostRequests: BudgetCounterStats;
}

export interface Budget {
  /**
   * A Range request needs two things at once — room in the byte budget and a
   * slot on its host — so it asks for both in one call and gets one lease
   * that returns both. Neither is reserved unless both are available.
   */
  acquireRangeRequest(origin: string, bytes: number): Admission;
  /** One concurrent decode job (OVERVIEW §7: worker pool size × 2). */
  acquireDecodeJob(): Admission;
  /** Per-resource admitted/deferred/rejected counts and current/peak usage — see `BudgetStats`. */
  stats(): BudgetStats;
  /**
   * Marks the budget destroyed so further acquisitions are `rejected`, and
   * frees every reservation still outstanding. A lease held at this moment
   * did nothing wrong: its later `release()` is still accepted, once.
   *
   * Safe to call more than once: after the first call `active` is already
   * empty and every `acquire*` already returns before adding to it, so a
   * second call has nothing left to do.
   */
  destroy(): void;
}

/**
 * Builds a `Budget`: the module's one entry point. Unset limits fall back to
 * OVERVIEW §7's initial values.
 */
export function createBudget(limits?: Partial<BudgetLimits>): Budget {
  return new BudgetImpl(limits);
}

class BudgetImpl implements Budget {
  private readonly rangeBody: Counter;
  private readonly decode: Counter;
  private readonly hostRequestsPerOrigin: number;
  // This provider's own mirror of the host-slot budget — see the full
  // explanation on `BudgetStats.hostRequests`. Capacity here is infinite
  // because this counter never decides a verdict, only records one that was
  // already decided against the real per-origin counter in host-registry.ts.
  private readonly hostRequests = new Counter(Number.POSITIVE_INFINITY);

  private readonly active = new Set<OutstandingLease>();
  private destroyed = false;

  constructor(limits?: Partial<BudgetLimits>) {
    this.rangeBody = new Counter(limits?.rangeBodyBytes ?? DEFAULT_RANGE_BODY_BYTES);
    this.decode = new Counter(limits?.decodeJobs ?? DEFAULT_DECODE_JOBS);
    this.hostRequestsPerOrigin = limits?.hostRequestsPerOrigin ?? DEFAULT_HOST_REQUESTS_PER_ORIGIN;
  }

  acquireRangeRequest(origin: string, bytes: number): Admission {
    if (this.destroyed) {
      this.rangeBody.recordRejected();
      this.hostRequests.recordRejected();
      return { verdict: 'rejected', reason: 'destroyed' };
    }

    const host = counterForOrigin(origin, this.hostRequestsPerOrigin);

    // Checked before either counter is touched, so a request too big for one
    // side never leaves the other side committed. Each side records its own
    // verdict only when it was itself the one lacking capacity or room — a
    // call that bytes alone deferred or rejected must not also mark the host
    // side deferred or rejected, or the two counters could never disagree and
    // §7 retuning could not tell which resource to widen.
    const bytesFit = this.rangeBody.fitsCapacity(bytes);
    const hostFits = host.fitsCapacity(1);
    if (!bytesFit || !hostFits) {
      if (!bytesFit) this.rangeBody.recordRejected();
      if (!hostFits) this.hostRequests.recordRejected();
      return { verdict: 'rejected', reason: 'over-capacity' };
    }

    const bytesHaveRoom = this.rangeBody.hasRoom(bytes);
    const hostHasRoom = host.hasRoom(1);
    if (!bytesHaveRoom || !hostHasRoom) {
      if (!bytesHaveRoom) this.rangeBody.recordDeferred();
      if (!hostHasRoom) this.hostRequests.recordDeferred();
      return { verdict: 'deferred' };
    }

    this.rangeBody.commit(bytes);
    host.commit(1);
    this.hostRequests.commit(1);
    this.rangeBody.recordAdmitted();
    this.hostRequests.recordAdmitted();

    const record: OutstandingLease = {
      status: 'active',
      free: () => {
        this.rangeBody.release(bytes);
        host.release(1);
        this.hostRequests.release(1);
      },
    };
    this.active.add(record);
    return { verdict: 'admitted', lease: createLease(record, this.active) };
  }

  acquireDecodeJob(): Admission {
    return this.acquireSingle(this.decode);
  }

  private acquireSingle(counter: Counter): Admission {
    if (this.destroyed) {
      counter.recordRejected();
      return { verdict: 'rejected', reason: 'destroyed' };
    }
    if (!counter.fitsCapacity(1)) {
      counter.recordRejected();
      return { verdict: 'rejected', reason: 'over-capacity' };
    }
    if (!counter.hasRoom(1)) {
      counter.recordDeferred();
      return { verdict: 'deferred' };
    }

    counter.commit(1);
    counter.recordAdmitted();
    const record: OutstandingLease = {
      status: 'active',
      free: () => counter.release(1),
    };
    this.active.add(record);
    return { verdict: 'admitted', lease: createLease(record, this.active) };
  }

  stats(): BudgetStats {
    return {
      rangeBody: this.rangeBody.stats(),
      decode: this.decode.stats(),
      hostRequests: this.hostRequests.stats(),
    };
  }

  destroy(): void {
    this.destroyed = true;
    for (const record of this.active) {
      record.free();
      record.status = 'adopted';
    }
    this.active.clear();
  }
}
