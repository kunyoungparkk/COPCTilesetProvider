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
      'This lease was already released. Every acquireRangeRequest and ' +
        'acquireDecodeJob admission must be released exactly once — releasing it ' +
        'twice is a bug in the caller, not something the budget can recover from.',
    );
  }
}

/**
 * `Budget.acquireRangeRequest` returned `'rejected'` for a tile's content
 * request.
 *
 * Unlike `'deferred'` — which Cesium re-asks next frame (`ScheduledRangeResource`
 * returns `undefined` for it, matching `Cesium3DTile.js`'s own contract) —
 * `'rejected'` is permanent, so Cesium has to see a failed tile rather than one
 * that stays pending forever. `'over-capacity'` means this request could never
 * fit even with nothing else outstanding — the byte budget or the host's
 * concurrent-request cap is smaller than this one request; `'destroyed'` means
 * the provider that owns this budget has already been torn down.
 */
export class RangeRequestRejectedError extends CopcTilesetError {
  readonly code = 'range-request-rejected';
  readonly url: string;
  readonly reason: 'over-capacity' | 'destroyed';

  constructor(url: string, reason: 'over-capacity' | 'destroyed') {
    super(
      reason === 'destroyed'
        ? `${url} could not be requested: this provider has been destroyed, and its ` +
          'budget rejects every acquisition from that point on. This tile will not be ' +
          'retried — the provider itself is gone.'
        : `${url} could not be requested: this one request is larger than ` +
          'the whole Range-response budget this provider will ever hold at once, so no ' +
          'amount of waiting would free enough room for it. That budget is not ' +
          'adjustable through this library — the file is what has to change. Rewrite ' +
          'it with fewer points per node, so that no single node\'s compressed chunk is ' +
          'that large.',
    );
    this.url = url;
    this.reason = reason;
  }
}
