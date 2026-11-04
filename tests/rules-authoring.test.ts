import { describe, expect, it } from "vitest";
import recorded from "../fixtures/ai/recorded.json";
import { AuthoringInput, ProposePaymentInput, toRuleset } from "@/domain/authoring";
import { DEMO_CONTACTS, DEMO_RULESET } from "@/domain/demo";
import { describeRule, describeRuleset } from "@/domain/english";
import { buildMonthPlan } from "@/domain/plan";
import { canonicalJson, parseRuleset, RulesetError, type Ruleset } from "@/domain/rules";

const clone = (rs: Ruleset): Ruleset => JSON.parse(JSON.stringify(rs));

describe("rules schema", () => {
  it("accepts the demo rules", () => {
    expect(() => parseRuleset(DEMO_RULESET)).not.toThrow();
  });
  it("rejects floats and negative money", () => {
    const rs = clone(DEMO_RULESET);
    (rs.rules[0] as { amountCents: number }).amountCents = 50.5;
    expect(() => parseRuleset(rs)).toThrow(RulesetError);
    (rs.rules[0] as { amountCents: number }).amountCents = -100;
    expect(() => parseRuleset(rs)).toThrow(RulesetError);
  });
  it("refuses a skip rule on a guaranteed payment", () => {
    const rs = clone(DEMO_RULESET);
    rs.rules.push({ kind: "skip", id: "skip-sam", targetRuleId: "sam-groceries", capId: null });
    expect(() => parseRuleset(rs)).toThrow(/guaranteed, so it can never be skipped/);
  });
  it("refuses payments to recipients outside the approved list", () => {
    const rs = clone(DEMO_RULESET);
    rs.rules = rs.rules.map((r) => (r.kind === "approved_recipients" ? { ...r, recipientIds: ["sam"] } : r));
    expect(() => parseRuleset(rs)).toThrow(/not an approved recipient/);
  });
  it("refuses unknown references and duplicate ids", () => {
    const rs = clone(DEMO_RULESET);
    rs.rules.push({ kind: "cap", id: "cap-total", scope: { type: "overall" }, limitCents: 100 });
    expect(() => parseRuleset(rs)).toThrow(/duplicate id/);
    const rs2 = clone(DEMO_RULESET);
    rs2.rules.push({ kind: "skip", id: "skip-x", targetRuleId: "nope", capId: null });
    expect(() => parseRuleset(rs2)).toThrow(/unknown rule/);
  });
  it("hashes canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  it("puts a 31st-of-the-month payment on the last day of shorter months", () => {
    const rs = clone(DEMO_RULESET);
    rs.rules = rs.rules.map((r) => (r.id === "ava-day-1" && r.kind === "recurring" ? { ...r, schedule: { every: "month", day: 31 } } : r));
    const feb = buildMonthPlan(parseRuleset(rs), "2027-02");
    expect(feb.instances.find((i) => i.ruleId === "ava-day-1")?.date).toBe("2027-02-28");
    expect(describeRule(rs, rs.rules.find((r) => r.id === "ava-day-1")!)).toMatch(/last day of shorter months/);
  });
});

describe("plain-English template", () => {
  it("says exactly what the JSON says", () => {
    const text = describeRuleset(DEMO_RULESET).map((r) => r.text);
    expect(text).toEqual([
      "Send Sam Okafor $50.00 USD every Friday for groceries. Guaranteed: it must never be skipped.",
      "Send Ava Reyes $150.00 USD on the 1st of every month. Skippable: a skip rule may drop it.",
      'Send Sam Okafor an extra $20.00 USD each time "Sam does a big shop" happens, at most 2 times per calendar month.',
      "Never send more than $400.00 USD in total in any calendar month.",
      "Any one-off payment over $100.00 USD needs your approval first.",
      "Only ever pay approved recipients: Sam Okafor, Ava Reyes.",
    ]);
  });
});

describe("AI tool schemas", () => {
  it("the recorded authoring tool call validates and converts to the demo rules", () => {
    const input = AuthoringInput.parse(recorded.author[0].output);
    const { ruleset, unsupported } = toRuleset(input, DEMO_CONTACTS);
    expect(unsupported).toEqual([]);
    expect(ruleset).toEqual(DEMO_RULESET);
    expect(ruleset.recipients.map((r) => r.email)).toEqual(["sam.okafor.flat@example.com", "ava.reyes.brightline@example.com"]);
  });
  it("rejects dollar floats and missing fields from the model", () => {
    const bad = JSON.parse(JSON.stringify(recorded.author[0].output));
    bad.recurringPayments[0].amountCents = 50.0001;
    expect(AuthoringInput.safeParse(bad).success).toBe(false);
    const missing = JSON.parse(JSON.stringify(recorded.author[0].output));
    delete missing.spendingCaps;
    expect(AuthoringInput.safeParse(missing).success).toBe(false);
  });
  it("converts skip rules and per-recipient caps", () => {
    const input = AuthoringInput.parse({
      ...recorded.author[0].output,
      spendingCaps: [{ recipientName: null, limitCentsPerMonth: 40000 }, { recipientName: "Sam", limitCentsPerMonth: 30000 }],
      skipRules: [{ recipientName: "Sam", paymentType: "conditional_extra", protectsCapOf: null }],
    });
    const { ruleset } = toRuleset(input, DEMO_CONTACTS);
    expect(ruleset.rules.find((r) => r.kind === "skip")).toEqual({ kind: "skip", id: "skip-sam-big-shop", targetRuleId: "sam-big-shop", capId: "cap-total" });
    expect(ruleset.rules.find((r) => r.id === "cap-sam")).toMatchObject({ scope: { type: "recipient", recipientId: "sam" } });
  });
  it("refuses an invented weekly payment with no weekday", () => {
    const input = AuthoringInput.parse({
      ...recorded.author[0].output,
      recurringPayments: [{ ...recorded.author[0].output.recurringPayments[0], weekday: null }],
    });
    expect(() => toRuleset(input, DEMO_CONTACTS)).toThrow(/no weekday/);
  });
  it("the recorded agent proposals validate against propose_payment", () => {
    for (const a of recorded.agent) for (const c of a.toolCalls) expect(ProposePaymentInput.safeParse(c.input).success).toBe(true);
  });
});
