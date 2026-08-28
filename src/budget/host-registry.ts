import { Counter } from './counter.js';

/**
 * Host request slots: process-wide, keyed by origin.
 *
 * Module state on purpose. OVERVIEW §7's cap is sized against what one host
 * will carry, which two providers reading the same bucket genuinely share —
 * unlike the other three budgets, this one belongs to no single provider. A
 * provider's `destroy` releases only the slots that provider itself holds, by
 * walking its own outstanding leases; it never resets another provider's share
 * of an origin's counter.
 *
 * What a slot counts is one admitted *tile read*, which is not the same as one
 * connection: a slot is taken before `createCoalescingReader` has had a chance
 * to merge that read with its neighbours, and several slots can end up sharing
 * one request. The cap therefore bounds connections from above rather than
 * matching them — safe in the direction that matters, and costing only the
 * connections it leaves unused. §7 carries the figure to retune it against.
 *
 * An origin's capacity is fixed by whichever `acquireRangeRequest` call first
 * touches it. A later `Budget` constructed with a different
 * `hostRequestsPerOrigin` joins the existing counter rather than resizing it —
 * the slots are shared and cannot have two capacities at once. One consequence
 * worth knowing: a joiner's `over-capacity` rejection can reflect the first
 * writer's capacity rather than its own — a provider configured with
 * `hostRequestsPerOrigin: 0` that touches an origin first makes that origin
 * permanently `over-capacity` for every correctly-configured provider that
 * touches it afterwards, for the life of the process. `hostRequestsPerOrigin`
 * must therefore stay a constructor option and never become public API
 * (`BudgetLimits`'s doc comment says the same for all four limits): a caller
 * who could set it per call would be one bad value away from breaking every
 * other provider sharing that origin.
 */
const hostCounters = new Map<string, Counter>();

/** The shared counter for `origin`, created with `defaultCapacity` on first use. */
export function counterForOrigin(origin: string, defaultCapacity: number): Counter {
  const existing = hostCounters.get(origin);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Counter(defaultCapacity);
  hostCounters.set(origin, created);
  return created;
}
