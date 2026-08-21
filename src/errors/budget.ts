import { CopcTilesetError } from './base.js';

/**
 * A second `release()` on the same lease.
 *
 * Decision 5's "exactly once" is only enforceable if a duplicate is
 * observable — a silent no-op here would let a double-release hide until the
 * budget's counters drifted far enough to notice. Following the
 * `InvalidByteRangeError` precedent, a condition the budget's own structure
 * makes impossible fails loudly rather than being tolerated.
 */
export class LeaseAlreadyReleasedError extends CopcTilesetError {
  readonly code = 'lease-already-released';

  constructor() {
    super(
      'This lease was already released. Every acquireRangeRequest, acquireDecodeJob, ' +
        'and acquireHierarchyPage admission must be released exactly once — releasing ' +
        'it twice is a bug in the caller, not something the budget can recover from.',
    );
  }
}
