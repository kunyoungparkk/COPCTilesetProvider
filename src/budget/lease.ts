import { LeaseAlreadyReleasedError } from '../errors/index.js';

/** Not idempotent on purpose: a second `release` is a bug, and says so. */
export interface Lease {
  release(): void;
}

type LeaseStatus = 'active' | 'adopted' | 'released';

/**
 * What a `Budget` tracks per outstanding reservation, so `destroy` can free it
 * without knowing which resource(s) it holds.
 *
 * `status` starts `'active'`. A normal `release()` frees the resource itself
 * and moves straight to `'released'`. `destroy()` instead frees the resource
 * and moves to `'adopted'` — the holder did nothing wrong, so its later
 * `release()` still succeeds, just without freeing anything a second time.
 * From either `'adopted'` or `'released'`, a further `release()` throws.
 */
export interface OutstandingLease {
  status: LeaseStatus;
  readonly free: () => void;
}

/** Wraps a lease record in the public, single-use `release()` surface. */
export function createLease(record: OutstandingLease, active: Set<OutstandingLease>): Lease {
  return {
    release(): void {
      if (record.status === 'released') {
        throw new LeaseAlreadyReleasedError();
      }
      if (record.status === 'active') {
        record.free();
        active.delete(record);
      }
      record.status = 'released';
    },
  };
}
