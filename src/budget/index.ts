/**
 * The budget's only intended surface is admission: `createBudget`, the
 * `Budget` it returns, and the types needed to call it. `Counter` and the
 * process-wide host-slot registry are how the four resources are actually
 * tracked, and stay out of this barrel — nothing outside `Budget`'s own
 * methods needs to touch a counter directly, and exporting one would let a
 * caller mutate a reservation without going through the acquire/release pair
 * Decision 5 relies on.
 */
export type {
  Admission,
  Budget,
  BudgetLimits,
  BudgetStats,
  RejectionReason,
} from './budget.js';
export { createBudget } from './budget.js';
export type { BudgetCounterStats } from './counter.js';
export type { Lease } from './lease.js';
