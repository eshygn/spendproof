import { describe, expect, it } from "vitest";
import { DEMO_RULESET } from "@/domain/demo";
import { evaluatePayout, type GateContext, type PaidRecord, type PayoutRequest } from "@/domain/gatekeeper";
import { canRetry, countsAsSpent, isFinal, transition } from "@/domain/payoutStatus";
import { parseRuleset, type Ruleset } from "@/domain/rules";

const RS: Ruleset = parseRuleset({
  ...DEMO_RULESET,
  rules: [...DEMO_RULESET.rules, { kind: "skip", id: "skip-sam-big-shop", targetRuleId: "sam-big-shop", capId: "cap-total" }],
});
const HASH = "rv_test000000";

function ctx(history: PaidRecord[] = [], over: Partial<GateContext> = {}): GateContext {
  return {
    ruleset: RS,
    rulesHash: HASH,
    verification: { hash: HASH, verdict: "verified", start: "2026-11-01", end: "2027-10-31" },
    history,
    events: new Set(["sam-big-shop@2026-11-09", "sam-big-shop@2027-01-04", "sam-big-shop@2027-01-12"]),
    balanceCents: 100_000,
    ...over,
  };
}

const sam = { recipientName: "Sam Okafor", recipientEmail: "sam.okafor.flat@example.com" };
const ava = { recipientName: "Ava Reyes", recipientEmail: "ava.reyes.brightline@example.com" };
const sched = (date: string, ruleId: string, amountCents: number, who = sam): PayoutRequest => ({ source: "scheduler", date, ruleId, amountCents, ...who });
const paid = (date: string, ruleId: string | null, recipientId: string, amountCents: number): PaidRecord => ({
  date, ruleId, recipientId, amountCents, instanceKey: ruleId ? `${ruleId}@${date}` : null,
});

describe("gatekeeper: the landlord email", () => {
  it("blocks $1,800 to a new account and names every rule it breaks", () => {
    const v = evaluatePayout(
      { source: "agent", date: "2026-11-01", recipientName: "Harbour Lane Lettings", recipientEmail: "rent-collections@harbourlane-payments.example.com", amountCents: 180000, ruleId: null },
      ctx(),
    );
    expect(v.decision).toBe("block");
    expect(v.violations.map((x) => x.ruleTitle)).toEqual(["Approved recipients", "$400 monthly total cap", "Approval over $100"]);
    expect(v.violations.map((x) => x.ruleId)).toEqual(["approved", "cap-total", "approval-over-100"]);
  });
  it("refuses a known payee's name with a different PayPal account", () => {
    const v = evaluatePayout({ source: "agent", date: "2026-11-02", recipientName: "Sam Okafor", recipientEmail: "sam.new@example.com", amountCents: 1000, ruleId: null }, ctx());
    expect(v.decision).toBe("block");
    expect(v.violations[0].code).toBe("recipient_mismatch");
  });
});

describe("gatekeeper: scheduled payments", () => {
  it("allows a payment that matches its verified rule and stamps the rules version", () => {
    const v = evaluatePayout(sched("2026-11-06", "sam-groceries", 5000), ctx());
    expect(v.decision).toBe("allow");
    expect(v.rulesHash).toBe(HASH);
    expect(v.instanceKey).toBe("sam-groceries@2026-11-06");
  });
  it("blocks duplicates, wrong amounts, wrong days and unreported events", () => {
    expect(evaluatePayout(sched("2026-11-06", "sam-groceries", 5000), ctx([paid("2026-11-06", "sam-groceries", "sam", 5000)])).violations[0].code).toBe("duplicate");
    expect(evaluatePayout(sched("2026-11-06", "sam-groceries", 9000), ctx()).violations[0].code).toBe("amount_mismatch");
    expect(evaluatePayout(sched("2026-11-07", "sam-groceries", 5000), ctx()).violations[0].code).toBe("not_due");
    expect(evaluatePayout(sched("2026-11-10", "sam-big-shop", 2000), ctx()).violations[0].code).toBe("no_event");
  });
  it("applies the skip rule to the January extras using the actual history", () => {
    const history = [
      paid("2027-01-01", "sam-groceries", "sam", 5000),
      paid("2027-01-01", "ava-day-1", "ava", 15000),
    ];
    const v = evaluatePayout(sched("2027-01-04", "sam-big-shop", 2000), ctx(history));
    expect(v.decision).toBe("block");
    expect(v.violations[0].code).toBe("skipped");
    expect(v.violations[0].ruleId).toBe("skip-sam-big-shop");
  });
  it("refuses anything that would push the month over the cap", () => {
    const history = [paid("2026-11-01", null, "ava", 38000)];
    const v = evaluatePayout(sched("2026-11-06", "sam-groceries", 5000), ctx(history));
    expect(v.violations.map((x) => x.code)).toEqual(["cap"]);
  });
  it("blocks rules that are not verified, or dates outside the horizon", () => {
    expect(evaluatePayout(sched("2026-11-06", "sam-groceries", 5000), ctx([], { verification: null })).violations[0].code).toBe("unverified");
    expect(evaluatePayout(sched("2027-11-05", "sam-groceries", 5000), ctx()).violations[0].code).toBe("unverified");
  });
  it("refuses payouts the funded balance cannot cover", () => {
    expect(evaluatePayout(sched("2026-11-06", "sam-groceries", 5000), ctx([], { balanceCents: 1000 })).violations[0].code).toBe("balance");
  });
});

describe("gatekeeper: one-off payments", () => {
  it("allows a small one-off to an approved recipient with room left after reserving what is still due", () => {
    const v = evaluatePayout({ source: "agent", date: "2026-11-01", ...ava, amountCents: 4500, ruleId: null }, ctx());
    expect(v.decision).toBe("allow");
  });
  it("blocks a one-off that fits today but would starve a guaranteed payment later", () => {
    const v = evaluatePayout({ source: "agent", date: "2026-11-01", ...ava, amountCents: 9000, ruleId: null }, ctx());
    expect(v.violations.map((x) => x.code)).toEqual(["cap_reserve"]);
  });
  it("asks for approval above the threshold, and allows it once approved", () => {
    const rs = parseRuleset({ ...RS, rules: RS.rules.map((r) => (r.id === "cap-total" ? { ...r, limitCents: 100000 } : r)) });
    const req: PayoutRequest = { source: "agent", date: "2026-11-01", ...ava, amountCents: 12000, ruleId: null };
    expect(evaluatePayout(req, ctx([], { ruleset: rs })).decision).toBe("needs_approval");
    expect(evaluatePayout({ ...req, approvedByPerson: true }, ctx([], { ruleset: rs })).decision).toBe("allow");
  });
});

describe("payout state machine", () => {
  it("follows PayPal statuses forward and never backwards", () => {
    expect(transition("queued", "PENDING")).toBe("pending");
    expect(transition("pending", "SUCCESS")).toBe("success");
    expect(transition("pending", "UNCLAIMED")).toBe("unclaimed");
    expect(transition("unclaimed", "SUCCESS")).toBe("success");
    expect(transition("success", "PENDING")).toBe("success");
    expect(transition("failed", "SUCCESS")).toBe("failed");
    expect(transition("pending", "PROCESSING")).toBe("pending");
  });
  it("knows what counts as spent, what is final and what can be retried", () => {
    expect(countsAsSpent("pending")).toBe(true);
    expect(countsAsSpent("unclaimed")).toBe(true);
    expect(countsAsSpent("failed")).toBe(false);
    expect(countsAsSpent("blocked")).toBe(false);
    expect(isFinal("success")).toBe(true);
    expect(isFinal("unclaimed")).toBe(false);
    expect(canRetry("failed", false)).toBe(true);
    expect(canRetry("failed", true)).toBe(false);
    expect(canRetry("success", false)).toBe(false);
  });
});
