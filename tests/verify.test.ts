import { beforeAll, describe, expect, it } from "vitest";
import { init } from "z3-solver";
import { DEMO_RULESET, DEMO_START } from "@/domain/demo";
import { buildHorizon, buildMonthPlan } from "@/domain/plan";
import { suggestRepairs } from "@/domain/repairs";
import { parseRuleset, type Rule, type Ruleset } from "@/domain/rules";
import { simulateMonth } from "@/domain/simulate";
import { __test, holds, verify, type Z3Ctx } from "@/domain/verify";

let Z: Z3Ctx;
beforeAll(async () => {
  const { Context } = await init();
  Z = new Context("main");
});

const withSkip = (rs: Ruleset): Ruleset =>
  parseRuleset({ ...rs, rules: [...rs.rules, { kind: "skip", id: "skip-sam-big-shop", targetRuleId: "sam-big-shop", capId: "cap-total" }] });

describe("simulator", () => {
  it("reaches $440 in January 2027 with two big shops, and refuses Sam's 29 Jan payment when caps are enforced", () => {
    const plan = buildMonthPlan(DEMO_RULESET, "2027-01");
    const events = new Set(["sam-big-shop@2027-01-04", "sam-big-shop@2027-01-12"]);
    const free = simulateMonth(DEMO_RULESET, plan, events, { enforce: false });
    expect(free.totals["cap-total"]).toBe(44000);
    const enforced = simulateMonth(DEMO_RULESET, plan, events, { enforce: true });
    expect(enforced.refusedGuaranteed.map((s) => s.instance.date)).toEqual(["2027-01-29"]);
  });
  it("with the skip rule, skips the extras in January and pays every Friday", () => {
    const rs = withSkip(DEMO_RULESET);
    const plan = buildMonthPlan(rs, "2027-01");
    const sim = simulateMonth(rs, plan, new Set(["sam-big-shop@2027-01-04", "sam-big-shop@2027-01-12"]), { enforce: true });
    expect(sim.totals["cap-total"]).toBe(40000);
    expect(sim.steps.filter((s) => s.decision.outcome === "skipped").length).toBe(2);
    expect(sim.refusedGuaranteed).toEqual([]);
  });
  it("counts extras against the monthly maximum", () => {
    const plan = buildMonthPlan(DEMO_RULESET, "2026-11");
    const events = new Set(["2026-11-02", "2026-11-03", "2026-11-04"].map((d) => `sam-big-shop@${d}`));
    const sim = simulateMonth(DEMO_RULESET, plan, events, { enforce: false });
    expect(sim.steps.filter((s) => s.instance.kind === "extra" && s.decision.outcome === "paid").length).toBe(2);
    expect(sim.steps.find((s) => s.instance.key === "sam-big-shop@2026-11-04")?.decision.outcome).toBe("over_limit");
  });
});

describe("Z3 verification", () => {
  it("finds January 2027 as the earliest counterexample, replayed by the simulator, with a minimal core", async () => {
    const report = await verify(Z, { ruleset: DEMO_RULESET, start: DEMO_START });
    expect(report.verdict).toBe("counterexample");
    const f = report.failure!;
    expect(f.month).toBe("2027-01");
    expect(f.counterexample.totalCents).toBe(44000);
    expect(f.counterexample.limitCents).toBe(40000);
    expect(f.counterexample.replayConfirmed).toBe(true);
    expect(f.counterexample.refusedGuaranteed).toEqual([{ ruleId: "sam-groceries", date: "2027-01-29", amountCents: 5000 }]);
    // Ava's $150 is arithmetically part of the clash: without it January peaks at $290.
    expect(f.core).toEqual(["sam-groceries", "ava-day-1", "sam-big-shop", "cap-total"]);
    // Independent replay of the reported events.
    const plan = buildMonthPlan(DEMO_RULESET, "2027-01");
    const sim = simulateMonth(DEMO_RULESET, plan, new Set(f.counterexample.events.map((e) => e.key)), { enforce: false });
    expect(sim.totals["cap-total"]).toBe(44000);
    expect(report.properties.find((p) => p.ruleId === "sam-groceries")?.status).toBe("broken");
    expect(report.months.find((m) => m.month === "2026-11")?.caps[0].worstCaseCents).toBe(39000);
  });

  it("proves the repaired rules for every month of the horizon", async () => {
    const report = await verify(Z, { ruleset: withSkip(DEMO_RULESET), start: DEMO_START });
    expect(report.verdict).toBe("verified");
    expect(report.failure).toBeNull();
    expect(report.months).toHaveLength(12);
    expect(report.properties.every((p) => p.status === "proved")).toBe(true);
    expect(Math.max(...report.months.map((m) => m.caps[0].worstCaseCents))).toBe(40000);
  });

  it("gives identical verdicts with and without month-shape sharing", async () => {
    for (const rs of [DEMO_RULESET, withSkip(DEMO_RULESET)]) {
      const a = await verify(Z, { ruleset: rs, start: DEMO_START, dedupe: true });
      const b = await verify(Z, { ruleset: rs, start: DEMO_START, dedupe: false });
      const strip = (r: typeof a) => r.months.map((m) => [m.month, m.caps, m.guarantee]);
      expect(strip(a)).toEqual(strip(b));
      expect(a.verdict).toBe(b.verdict);
    }
  });

  it("accounts for payments already made this month", async () => {
    // $260 already sent on 1–5 Nov: the remaining Fridays alone ($200) break the cap.
    const history = [{ date: "2026-11-03", ruleId: null, recipientId: "ava", amountCents: 26000 }];
    const report = await verify(Z, { ruleset: DEMO_RULESET, start: "2026-11-06", history });
    expect(report.failure?.month).toBe("2026-11");
  });
});

// Small random rulesets: every counterexample must replay, every proof must survive random simulation.
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function randomRuleset(r: () => number): Ruleset {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const rules: Rule[] = [
    { kind: "recurring", id: "a", recipientId: "x", amountCents: pick([2500, 5000, 7000]), schedule: { every: "week", weekday: Math.floor(r() * 7) }, guarantee: "guaranteed", purpose: "" },
    { kind: "recurring", id: "b", recipientId: "y", amountCents: pick([5000, 10000, 15000]), schedule: { every: "month", day: pick([1, 15, 29, 31]) }, guarantee: r() < 0.5 ? "guaranteed" : "skippable", purpose: "" },
    { kind: "extra", id: "c", recipientId: "x", amountCents: pick([1000, 2000, 3000]), trigger: "x shops", maxPerMonth: pick([1, 2, 3]), purpose: "" },
    { kind: "cap", id: "t", scope: { type: "overall" }, limitCents: pick([30000, 35000, 40000, 45000]) },
  ];
  if (r() < 0.5) rules.push({ kind: "cap", id: "cx", scope: { type: "recipient", recipientId: "x" }, limitCents: pick([20000, 25000, 30000]) });
  if (r() < 0.6) rules.push({ kind: "skip", id: "s", targetRuleId: "c", capId: null });
  return parseRuleset({
    currency: "USD",
    recipients: [
      { id: "x", name: "X Person", email: "x@example.com", role: "" },
      { id: "y", name: "Y Person", email: "y@example.com", role: "" },
    ],
    rules,
  });
}

describe("Z3 agrees with the simulator on random rulesets", () => {
  it("never reports an unconfirmed counterexample and never 'proves' something random simulation can break", async () => {
    const r = rng(42);
    for (let n = 0; n < 8; n++) {
      const rs = randomRuleset(r);
      const report = await verify(Z, { ruleset: rs, start: "2027-01-01", months: 3 });
      const horizon = buildHorizon(rs, "2027-01-01", 3);
      // Caps proved => guarantees proved (the implication `holds` relies on).
      if (report.properties.filter((p) => p.kind === "cap").every((p) => p.status === "proved")) {
        expect(report.properties.every((p) => p.status === "proved")).toBe(true);
      }
      expect(await holds(Z, { ruleset: rs, start: "2027-01-01", months: 3 })).toBe(report.verdict === "verified");
      for (const plan of horizon.months) {
        const mr = report.months.find((m) => m.month === plan.month)!;
        for (let k = 0; k < 40; k++) {
          const events = new Set(plan.instances.filter((i) => i.kind === "extra" && r() < 0.25).map((i) => i.key));
          const free = simulateMonth(rs, plan, events, { enforce: false });
          for (const c of mr.caps) {
            expect(free.totals[c.capId]).toBeLessThanOrEqual(c.worstCaseCents);
            if (c.status === "proved") expect(free.totals[c.capId]).toBeLessThanOrEqual(c.limitCents);
          }
          if (mr.guarantee === "proved") {
            expect(simulateMonth(rs, plan, events, { enforce: true }).refusedGuaranteed).toEqual([]);
          }
        }
      }
    }
  });
});

describe("repairs", () => {
  it("offers a verified skip rule, the largest safe amounts and the smallest safe cap", async () => {
    const report = await verify(Z, { ruleset: DEMO_RULESET, start: DEMO_START });
    const repairs = await suggestRepairs(Z, { ruleset: DEMO_RULESET, start: DEMO_START, report });
    const byId = Object.fromEntries(repairs.map((r) => [r.id, r]));
    expect(byId["add_skip:sam-big-shop"].text).toBe(
      'Skip Sam\'s $20 extra for "Sam does a big shop" in any month where paying it would break the $400 monthly total cap.',
    );
    expect(byId["lower_amount:sam-groceries"].toCents).toBe(4200);
    expect(byId["lower_amount:ava-day-1"].toCents).toBe(11000);
    expect(byId["raise_cap:cap-total"].toCents).toBe(44000);
    expect(byId["add_skip:ava-day-1"]).toBeUndefined(); // skipping Ava alone does not fix January
    for (const rep of repairs) expect((await verify(Z, { ruleset: rep.ruleset, start: DEMO_START })).verdict).toBe("verified");
    // One dollar more than the largest safe amount must fail.
    const over = parseRuleset({
      ...DEMO_RULESET,
      rules: DEMO_RULESET.rules.map((r) => (r.id === "sam-groceries" ? { ...r, amountCents: 4300 } : r)),
    });
    expect(await holds(Z, { ruleset: over, start: DEMO_START })).toBe(false);
  });
});

describe("encoding internals", () => {
  it("one free Boolean per day per extra", () => {
    const plan = buildMonthPlan(DEMO_RULESET, "2027-01");
    const enc = __test.encodeMonth(Z, DEMO_RULESET, plan, { enforce: false });
    expect(enc.events.size).toBe(31);
  });
});
