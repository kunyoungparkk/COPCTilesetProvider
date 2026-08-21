/** `admitted`, `deferred`, `rejected` and `inUse`/`peak` for one resource. */
export interface BudgetCounterStats {
  readonly admitted: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly inUse: number;
  readonly peak: number;
}

/**
 * One resource's reservation state: how much is in use, the high-water mark,
 * and how many times each verdict was handed out.
 *
 * Capacity checking is split from mutation on purpose. `fitsCapacity` and
 * `hasRoom` are pure — they answer without reserving anything — so a caller
 * that must check two counters before touching either (the composite Range
 * request in `budget.ts`) can decide the whole verdict first and only then
 * call `commit`. That split is what keeps the atomic acquisition atomic:
 * nothing here reserves as a side effect of checking.
 */
export class Counter {
  private readonly capacity: number;
  private inUseAmount = 0;
  private peakAmount = 0;
  private admittedCount = 0;
  private deferredCount = 0;
  private rejectedCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Whether `amount` could ever be admitted, regardless of current usage. */
  fitsCapacity(amount: number): boolean {
    return amount <= this.capacity;
  }

  /** Whether `amount` is available right now. */
  hasRoom(amount: number): boolean {
    return this.inUseAmount + amount <= this.capacity;
  }

  /** Reserves `amount`. Callers must have already checked `hasRoom`. */
  commit(amount: number): void {
    this.inUseAmount += amount;
    if (this.inUseAmount > this.peakAmount) {
      this.peakAmount = this.inUseAmount;
    }
  }

  /** Returns `amount` to the pool. */
  release(amount: number): void {
    this.inUseAmount -= amount;
  }

  recordAdmitted(): void {
    this.admittedCount += 1;
  }

  recordDeferred(): void {
    this.deferredCount += 1;
  }

  recordRejected(): void {
    this.rejectedCount += 1;
  }

  stats(): BudgetCounterStats {
    return {
      admitted: this.admittedCount,
      deferred: this.deferredCount,
      rejected: this.rejectedCount,
      inUse: this.inUseAmount,
      peak: this.peakAmount,
    };
  }
}
