/**
 * The payout state machine. Spendproof's own states plus PayPal's documented
 * payout item `transaction_status` values.
 *
 *   queued ──► pending ──► success | unclaimed | onhold | failed | returned | blocked | denied | refunded
 *     │                         unclaimed ──► success | returned
 *     └──► failed (PayPal refused the batch)          onhold ──► success | failed
 *   blocked: refused by the gatekeeper, never sent.
 *   failed:  can be retried once; the retry is a new payout that the gatekeeper re-checks.
 */

export type PayoutStatus =
  | "queued"
  | "pending"
  | "success"
  | "unclaimed"
  | "onhold"
  | "failed"
  | "returned"
  | "blocked"
  | "denied"
  | "refunded"
  | "reversed";

const NEXT: Record<PayoutStatus, PayoutStatus[]> = {
  queued: ["pending", "failed"],
  pending: ["pending", "success", "unclaimed", "onhold", "failed", "returned", "blocked", "denied", "refunded", "reversed"],
  unclaimed: ["unclaimed", "success", "returned"],
  onhold: ["onhold", "success", "failed"],
  success: ["success", "refunded", "reversed"],
  failed: [],
  returned: [],
  blocked: [],
  denied: [],
  refunded: [],
  reversed: [],
};

/** PayPal transaction_status (SUCCESS, FAILED, PENDING, UNCLAIMED, RETURNED, ONHOLD, BLOCKED, REFUNDED, REVERSED, DENIED). */
export function fromPayPal(transactionStatus: string): PayoutStatus {
  const s = transactionStatus.toLowerCase();
  if (s === "new" || s === "processing") return "pending";
  if (s in NEXT) return s as PayoutStatus;
  return "pending";
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return NEXT[from].includes(to);
}

/** Apply a PayPal update; an illegal move (e.g. success -> pending) keeps the current state. */
export function transition(from: PayoutStatus, paypalStatus: string): PayoutStatus {
  const to = fromPayPal(paypalStatus);
  return canTransition(from, to) ? to : from;
}

export function isFinal(s: PayoutStatus): boolean {
  return !["queued", "pending", "unclaimed", "onhold"].includes(s);
}

/** Does money count as gone (for caps and the funded balance)? */
export function countsAsSpent(s: string): boolean {
  return !["failed", "returned", "blocked", "denied", "refunded", "reversed"].includes(s);
}

export function canRetry(s: PayoutStatus, alreadyRetried: boolean): boolean {
  return s === "failed" && !alreadyRetried;
}
