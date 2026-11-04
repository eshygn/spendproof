import { firstOfMonth, formatDate, monthName, monthOf, type IsoDate } from "@/lib/calendar";
import { formatMoney, type Cents } from "@/lib/money";
import { ruleTitle } from "./english";
import { buildMonthPlan, type HistoryEntry } from "./plan";
import { capsFor, type CapRuleT, type Ruleset } from "./rules";
import { decide, type MonthState } from "./simulate";

/**
 * The gatekeeper. Deterministic code — not the AI — that stands between every
 * payout and PayPal. It re-checks each payout against the active, verified
 * rules and the actual payment history, and names every rule a payout breaks.
 */

export interface PayoutRequest {
  source: "scheduler" | "agent" | "retry";
  date: IsoDate;
  recipientName: string;
  recipientEmail: string;
  amountCents: Cents;
  /** Scheduled payments carry their rule; one-off proposals have none. */
  ruleId: string | null;
  /** True when the person has explicitly approved this one-off. */
  approvedByPerson?: boolean;
}

export interface PaidRecord extends HistoryEntry {
  instanceKey: string | null;
}

export interface GateContext {
  ruleset: Ruleset;
  rulesHash: string;
  verification: { hash: string; verdict: string; start: IsoDate; end: IsoDate } | null;
  /** Payouts that count: sent, pending or succeeded (not failed). */
  history: readonly PaidRecord[];
  /** Keys of extras whose event has been reported (ruleId@date). */
  events: ReadonlySet<string>;
  balanceCents: Cents;
}

export type Severity = "block" | "approval";

export interface Violation {
  code:
    | "unverified"
    | "unapproved_recipient"
    | "recipient_mismatch"
    | "cap"
    | "cap_reserve"
    | "approval"
    | "not_due"
    | "amount_mismatch"
    | "duplicate"
    | "no_event"
    | "extra_limit"
    | "skipped"
    | "balance";
  severity: Severity;
  ruleId: string | null;
  ruleTitle: string;
  message: string;
}

export interface Verdict {
  decision: "allow" | "needs_approval" | "block";
  violations: Violation[];
  passed: string[];
  rulesHash: string;
  recipientId: string | null;
  instanceKey: string | null;
}

const money = (c: Cents) => formatMoney(c);

export { countsAsSpent as countsTowardHistory } from "./payoutStatus";

export function evaluatePayout(req: PayoutRequest, ctx: GateContext): Verdict {
  const { ruleset } = ctx;
  const violations: Violation[] = [];
  const passed: string[] = [];
  const v = (x: Violation) => violations.push(x);

  // 0. Only verified rules can move money, and only inside the verified horizon.
  const ver = ctx.verification;
  if (!ver || ver.hash !== ctx.rulesHash || ver.verdict !== "verified") {
    v({ code: "unverified", severity: "block", ruleId: null, ruleTitle: "Verified rules", message: "The active rules have not been verified by Z3." });
  } else if (req.date < ver.start || req.date > ver.end) {
    v({
      code: "unverified",
      severity: "block",
      ruleId: null,
      ruleTitle: "Verified rules",
      message: `${formatDate(req.date, { year: true })} is outside the verified horizon (${formatDate(ver.start, { year: true })} – ${formatDate(ver.end, { year: true })}).`,
    });
  } else passed.push(`Rules version ${ctx.rulesHash} is verified for ${formatDate(req.date, { year: true })}`);

  // 1. Recipient: must be approved, and the PayPal account must match the one on file.
  const email = req.recipientEmail.trim().toLowerCase();
  const byEmail = ruleset.recipients.find((r) => r.email.toLowerCase() === email);
  const byName = ruleset.recipients.find((r) => r.name.toLowerCase() === req.recipientName.trim().toLowerCase());
  const approvedRule = ruleset.rules.find((r) => r.kind === "approved_recipients");
  const approvedIds = new Set(approvedRule?.kind === "approved_recipients" ? approvedRule.recipientIds : ruleset.recipients.map((r) => r.id));
  const recipient = byEmail ?? null;
  const approvedTitle = approvedRule ? ruleTitle(ruleset, approvedRule) : "Approved recipients";
  if (byName && !byEmail) {
    v({
      code: "recipient_mismatch",
      severity: "block",
      ruleId: approvedRule?.id ?? null,
      ruleTitle: approvedTitle,
      message: `${req.recipientEmail} is not ${byName.name}'s PayPal account on file. A changed account is never accepted from a message.`,
    });
  } else if (!recipient || !approvedIds.has(recipient.id)) {
    v({
      code: "unapproved_recipient",
      severity: "block",
      ruleId: approvedRule?.id ?? null,
      ruleTitle: approvedTitle,
      message: `${req.recipientName} <${req.recipientEmail}> is not an approved recipient.`,
    });
  } else passed.push(`${recipient.name} is an approved recipient`);

  const month = monthOf(req.date);
  const monthHistory = ctx.history.filter((h) => monthOf(h.date) === month);
  const instanceKey = req.ruleId ? `${req.ruleId}@${req.date}` : null;

  // 3. Scheduled payments: must match their verified rule exactly.
  if (req.ruleId) {
    const rule = ruleset.rules.find((r) => r.id === req.ruleId);
    const title = rule ? ruleTitle(ruleset, rule) : req.ruleId;
    // The whole month's plan; the actual history decides what is already paid.
    const plan = buildMonthPlan(ruleset, month, firstOfMonth(month));
    const inst = plan.instances.find((i) => i.key === instanceKey);
    if (!rule || !inst) {
      v({ code: "not_due", severity: "block", ruleId: req.ruleId, ruleTitle: title, message: `Nothing is due under this rule on ${formatDate(req.date, { year: true })}.` });
    } else {
      if (inst.recipientId !== recipient?.id) {
        v({ code: "recipient_mismatch", severity: "block", ruleId: rule.id, ruleTitle: title, message: "The recipient does not match the rule." });
      }
      if (inst.amountCents !== req.amountCents) {
        v({ code: "amount_mismatch", severity: "block", ruleId: rule.id, ruleTitle: title, message: `The rule pays ${money(inst.amountCents)}, not ${money(req.amountCents)}.` });
      }
      if (ctx.history.some((h) => h.instanceKey === instanceKey)) {
        v({ code: "duplicate", severity: "block", ruleId: rule.id, ruleTitle: title, message: `This payment for ${formatDate(req.date)} has already been sent.` });
      }
      if (inst.kind === "extra" && !ctx.events.has(inst.key)) {
        v({ code: "no_event", severity: "block", ruleId: rule.id, ruleTitle: title, message: `No "${rule.kind === "extra" ? rule.trigger : "event"}" was reported for ${formatDate(req.date)}.` });
      }
      // The simulator's own decision for this instance, on the actual month's
      // history: everything already sent this month counts, and only the fixed
      // payments still unpaid after this one are reserved. (In normal running
      // this is exactly the simulator's state; it also stays right for retries.)
      const paidKeys = new Set(ctx.history.map((h) => h.instanceKey).filter(Boolean));
      const state: MonthState = { paidByCap: {}, extraCount: {} };
      for (const cap of plan.caps) state.paidByCap[cap.id] = 0;
      for (const h of monthHistory) {
        if (h.instanceKey === instanceKey) continue;
        for (const c of capsFor(ruleset, h.recipientId)) state.paidByCap[c.id] = (state.paidByCap[c.id] ?? 0) + h.amountCents;
        if (h.ruleId) state.extraCount[h.ruleId] = (state.extraCount[h.ruleId] ?? 0) + 1;
      }
      const fixedAfter: Record<string, Cents> = {};
      for (const cap of plan.caps) {
        fixedAfter[cap.id] = plan.instances
          .filter((j) => j.idx > inst.idx && j.fixed && j.capIds.includes(cap.id) && !paidKeys.has(j.key))
          .reduce((sum, j) => sum + j.amountCents, 0);
      }
      const d = decide(ruleset, { ...inst, fixedAfter }, state, true, true);
      if (d.outcome === "over_limit") {
        v({ code: "extra_limit", severity: "block", ruleId: rule.id, ruleTitle: title, message: `Already paid the maximum ${inst.maxPerMonth} times in ${monthName(month)}.` });
      } else if (d.outcome === "skipped") {
        const skipRule = ruleset.rules.find((r) => r.id === d.skipRuleId);
        v({
          code: "skipped",
          severity: "block",
          ruleId: d.skipRuleId ?? null,
          ruleTitle: skipRule ? ruleTitle(ruleset, skipRule) : "Skip rule",
          message: `Skipped this month: paying it would take the month to ${money(d.wouldReach ?? 0)} once the payments still due are counted.`,
        });
      } else if (d.outcome === "refused") {
        const cap = ruleset.rules.find((r) => r.id === d.capId) as CapRuleT;
        v({ code: "cap", severity: "block", ruleId: cap.id, ruleTitle: ruleTitle(ruleset, cap), message: `This would take ${monthName(month)} to ${money(d.wouldReach ?? 0)}, over the ${money(cap.limitCents)} cap.` });
      } else if (rule) passed.push(`Matches "${title}" and fits every cap`);
    }
  } else {
    // 4. One-off payments: every cap the recipient counts towards, with room
    // reserved for the fixed payments still due this month.
    const caps: CapRuleT[] = recipient
      ? capsFor(ruleset, recipient.id)
      : ruleset.rules.filter((r): r is CapRuleT => r.kind === "cap" && r.scope.type === "overall");
    const plan = buildMonthPlan(ruleset, month, req.date, ctx.history);
    for (const cap of caps) {
      const paid = monthHistory
        .filter((h) => cap.scope.type === "overall" || h.recipientId === cap.scope.recipientId)
        .reduce((s, h) => s + h.amountCents, 0);
      const reserved = plan.instances
        .filter((i) => i.fixed && i.capIds.includes(cap.id) && !ctx.history.some((h) => h.instanceKey === i.key))
        .reduce((s, i) => s + i.amountCents, 0);
      const title = ruleTitle(ruleset, cap);
      if (paid + req.amountCents > cap.limitCents) {
        v({
          code: "cap",
          severity: "block",
          ruleId: cap.id,
          ruleTitle: title,
          message: `${money(paid)} already sent in ${monthName(month)}; ${money(req.amountCents)} more would reach ${money(paid + req.amountCents)}, over the ${money(cap.limitCents)} cap.`,
        });
      } else if (paid + req.amountCents + reserved > cap.limitCents) {
        v({
          code: "cap_reserve",
          severity: "block",
          ruleId: cap.id,
          ruleTitle: title,
          message: `It fits today, but leaves no room for the ${money(reserved)} of scheduled payments still due in ${monthName(month)} — a guaranteed payment would be refused later.`,
        });
      } else passed.push(`Fits "${title}" with ${money(reserved)} reserved for payments still due`);
    }
    const approval = ruleset.rules.find((r) => r.kind === "approval");
    if (approval?.kind === "approval" && req.amountCents > approval.overCents) {
      if (req.approvedByPerson) passed.push(`Approved by you (over ${money(approval.overCents)})`);
      else {
        v({
          code: "approval",
          severity: "approval",
          ruleId: approval.id,
          ruleTitle: ruleTitle(ruleset, approval),
          message: `One-off payments over ${money(approval.overCents)} need your approval.`,
        });
      }
    }
  }

  // Last, a system check rather than a rule: the funded balance must cover it.
  // Only reported when the rules themselves would allow the payment.
  if (!violations.some((x) => x.severity === "block")) {
    if (req.amountCents > ctx.balanceCents) {
      v({
        code: "balance",
        severity: "block",
        ruleId: null,
        ruleTitle: "Funded balance",
        message: `${money(req.amountCents)} is more than the funded balance of ${money(ctx.balanceCents)}. Top up through PayPal.`,
      });
    } else passed.push(`Funded balance covers ${money(req.amountCents)}`);
  }

  const decision = violations.some((x) => x.severity === "block")
    ? "block"
    : violations.some((x) => x.severity === "approval")
      ? "needs_approval"
      : "allow";
  return { decision, violations, passed, rulesHash: ctx.rulesHash, recipientId: recipient?.id ?? null, instanceKey };
}
