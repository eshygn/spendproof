import type { Arith, Bool, Context, Model } from "z3-solver";
import { monthName, type IsoDate, type IsoMonth } from "@/lib/calendar";
import type { Cents } from "@/lib/money";
import { buildHorizon, type HistoryEntry, type Instance, type MonthPlan } from "./plan";
import type { CapRuleT, Ruleset } from "./rules";
import { simulateMonth, type MonthSimulation, type Outcome } from "./simulate";

/**
 * Verification with Z3.
 *
 * For every month of the horizon, every uncertain event (an extra's trigger on
 * a given day) is a free Boolean. Two kinds of property are checked per month:
 *
 *  - cap:       the rules can never take a cap's monthly total over its limit
 *               (encoded without the gatekeeper's safety net);
 *  - guarantee: with the gatekeeper enforcing caps, no guaranteed payment is
 *               ever refused.
 *
 * `sat` is a counterexample. It is replayed through the TypeScript simulator
 * and only reported if the simulator confirms it. `unsat` is a proof for
 * every possible sequence of events in the horizon — and nothing more.
 */

export type Z3Ctx = Context<"main">;

export interface CounterexampleStep {
  key: string;
  date: IsoDate;
  ruleId: string;
  recipientId: string;
  kind: Instance["kind"];
  amountCents: Cents;
  outcome: Outcome;
  /** Running total of the cap in question after this step. */
  runningCents: Cents;
}

export interface Counterexample {
  month: IsoMonth;
  property: { kind: "cap"; capId: string } | { kind: "guarantee"; ruleId: string; date: IsoDate };
  /** Uncertain events that happen (only the ones that matter). */
  events: { key: string; ruleId: string; date: IsoDate }[];
  steps: CounterexampleStep[];
  capId: string;
  totalCents: Cents;
  limitCents: Cents;
  /** Always true when reported: the simulator reproduced the violation. */
  replayConfirmed: true;
  /** Same events, with the gatekeeper enforcing caps: guaranteed payments it would refuse. */
  refusedGuaranteed: { ruleId: string; date: IsoDate; amountCents: Cents }[];
}

export interface CapMonthResult {
  capId: string;
  limitCents: Cents;
  /** Highest total any event sequence can reach (Z3 Optimize). */
  worstCaseCents: Cents;
  status: "proved" | "broken" | "unknown";
}

export interface MonthReport {
  month: IsoMonth;
  label: string;
  from: IsoDate;
  caps: CapMonthResult[];
  guarantee: "proved" | "broken" | "unknown" | "none";
  guaranteedCount: number;
  uncertainEvents: number;
  /** This month's proof is shared with an earlier month of the same shape. */
  sameShapeAs: IsoMonth | null;
}

export interface PropertySummary {
  id: string;
  kind: "cap" | "guarantee";
  ruleId: string;
  status: "proved" | "broken" | "unknown";
  firstBrokenMonth: IsoMonth | null;
}

export interface VerifyReport {
  verdict: "verified" | "counterexample" | "unknown";
  horizon: { start: IsoDate; end: IsoDate; months: number };
  months: MonthReport[];
  properties: PropertySummary[];
  failure: null | {
    month: IsoMonth;
    counterexample: Counterexample;
    /** Minimal set of rules that cannot all hold under this counterexample. */
    core: string[];
  };
  stats: { checks: number; ms: number; booleans: number; shapes: number };
}

export class ReplayMismatchError extends Error {}

// ---------------------------------------------------------------------------
// Encoding

interface Encoding {
  facts: Bool<"main">[];
  paid: Bool<"main">[];
  refused: Bool<"main">[];
  events: Map<number, Bool<"main">>;
  totals: Record<string, Arith<"main">>;
}

interface EncodeOpts {
  enforce: boolean;
  /** Fix events to exactly this set (for core extraction). */
  fixedEvents?: ReadonlySet<string>;
  /** Tracking literal per rule id (for unsat cores). */
  lit?: (ruleId: string) => Bool<"main">;
}

let uid = 0;

function encodeMonth(Z: Z3Ctx, ruleset: Ruleset, plan: MonthPlan, opts: EncodeOpts): Encoding {
  const tag = `${plan.month.replace("-", "")}_${++uid}`;
  const facts: Bool<"main">[] = [];
  const paid: Bool<"main">[] = [];
  const refused: Bool<"main">[] = [];
  const events = new Map<number, Bool<"main">>();
  const limit = (capId: string) => (plan.caps.find((c) => c.id === capId) as CapRuleT).limitCents;
  const run: Record<string, Arith<"main">> = {};
  for (const cap of plan.caps) run[cap.id] = Z.Int.val(plan.priorByCap[cap.id] ?? 0);
  const count: Record<string, Arith<"main">> = {};
  const { lit } = opts;

  for (const inst of plan.instances) {
    const i = inst.idx;
    let trig: Bool<"main"> = Z.Bool.val(true);
    let within: Bool<"main"> = Z.Bool.val(true);
    if (inst.kind === "extra") {
      const e = Z.Bool.const(`event_${tag}_${i}`);
      events.set(i, e);
      if (opts.fixedEvents) facts.push(opts.fixedEvents.has(inst.key) ? e : Z.Not(e));
      trig = e;
      count[inst.ruleId] ??= Z.Int.val(plan.priorExtraCount[inst.ruleId] ?? 0);
      within = count[inst.ruleId].lt(inst.maxPerMonth ?? 0);
    }

    // Skip rules: paid so far + this + fixed payments still to come > limit.
    const skipParts: Bool<"main">[] = [];
    for (const skip of inst.skips) {
      const conds = skip.capIds.map((c) =>
        run[c].add(inst.amountCents + (inst.fixedAfter[c] ?? 0)).gt(limit(c)),
      );
      const cond = conds.length ? Z.Or(...conds) : Z.Bool.val(false);
      if (lit) {
        const v = Z.Bool.const(`skip_${tag}_${i}_${skip.skipRuleId}`);
        const L = lit(skip.skipRuleId);
        facts.push(Z.Implies(L, v.eq(cond)), Z.Implies(Z.Not(L), Z.Not(v)));
        skipParts.push(v);
      } else skipParts.push(cond);
    }
    const skipped = skipParts.length ? Z.Or(...skipParts) : Z.Bool.val(false);

    // Gatekeeper enforcement: refuse anything that would push a cap over.
    const refParts: Bool<"main">[] = [];
    if (opts.enforce) {
      for (const c of inst.capIds) {
        const cond = run[c].add(inst.amountCents).gt(limit(c));
        if (lit) {
          const v = Z.Bool.const(`refuse_${tag}_${i}_${c}`);
          const L = lit(c);
          facts.push(Z.Implies(L, v.eq(cond)), Z.Implies(Z.Not(L), Z.Not(v)));
          refParts.push(v);
        } else refParts.push(cond);
      }
    }
    const intended = Z.And(trig, within, Z.Not(skipped));
    const ref = refParts.length ? Z.And(intended, Z.Or(...refParts)) : Z.Bool.val(false);
    refused.push(ref);

    const p = Z.Bool.const(`paid_${tag}_${i}`);
    const body = Z.And(intended, Z.Not(ref));
    if (lit) {
      const L = lit(inst.ruleId);
      facts.push(Z.Implies(L, p.eq(body)), Z.Implies(Z.Not(L), Z.Not(p)));
    } else facts.push(p.eq(body));
    paid.push(p);

    for (const c of inst.capIds) {
      const next = Z.Int.const(`run_${tag}_${i}_${c}`);
      facts.push(next.eq(run[c].add(Z.If(p, inst.amountCents, 0))));
      run[c] = next;
    }
    if (inst.kind === "extra") count[inst.ruleId] = count[inst.ruleId].add(Z.If(p, 1, 0));
  }
  // Redundant but sound lemma that speeds up proofs: an extra is paid at most
  // maxPerMonth times in a month (the sequential count already implies it).
  const byRule = new Map<string, Bool<"main">[]>();
  for (const inst of plan.instances) {
    if (inst.kind !== "extra") continue;
    byRule.set(inst.ruleId, [...(byRule.get(inst.ruleId) ?? []), paid[inst.idx]]);
  }
  for (const [ruleId, ps] of byRule) {
    const inst = plan.instances.find((x) => x.ruleId === ruleId) as Instance;
    const room = Math.max(0, (inst.maxPerMonth ?? 0) - (plan.priorExtraCount[ruleId] ?? 0));
    if (!lit) facts.push(Z.AtMost(ps as [Bool<"main">, ...Bool<"main">[]], room));
  }
  return { facts, paid, refused, events, totals: run };
}

function trueEvents(Z: Z3Ctx, model: Model<"main">, plan: MonthPlan, enc: Encoding): Set<string> {
  const out = new Set<string>();
  for (const [i, e] of enc.events) if (Z.isTrue(model.eval(e, true))) out.add(plan.instances[i].key);
  return out;
}

function intValue(Z: Z3Ctx, model: Model<"main">, expr: Arith<"main">): number {
  const v = model.eval(expr, true);
  if (!Z.isIntVal(v)) throw new Error("expected an integer value from the model");
  return Number(v.value());
}

// ---------------------------------------------------------------------------
// Replay through the simulator

/** Keep only the events that changed something, then confirm with the simulator. */
function replay(
  ruleset: Ruleset,
  plan: MonthPlan,
  events: Set<string>,
  check: (sim: MonthSimulation) => boolean,
  enforce: boolean,
): { sim: MonthSimulation; events: Set<string> } {
  const first = simulateMonth(ruleset, plan, events, { enforce });
  if (!check(first)) {
    throw new ReplayMismatchError(`Z3 counterexample for ${plan.month} did not reproduce in the simulator`);
  }
  const relevant = new Set(
    first.steps
      .filter((s) => events.has(s.instance.key) && s.decision.outcome !== "over_limit")
      .map((s) => s.instance.key),
  );
  const sim = simulateMonth(ruleset, plan, relevant, { enforce });
  if (!check(sim)) {
    throw new ReplayMismatchError(`Normalised counterexample for ${plan.month} did not reproduce`);
  }
  return { sim, events: relevant };
}

function toCounterexample(
  ruleset: Ruleset,
  plan: MonthPlan,
  sim: MonthSimulation,
  events: Set<string>,
  property: Counterexample["property"],
  capId: string,
): Counterexample {
  const cap = plan.caps.find((c) => c.id === capId) as CapRuleT;
  const enforced = simulateMonth(ruleset, plan, events, { enforce: true });
  return {
    month: plan.month,
    property,
    events: [...events].map((key) => {
      const inst = plan.instances.find((x) => x.key === key) as Instance;
      return { key, ruleId: inst.ruleId, date: inst.date };
    }),
    steps: sim.steps
      .filter((s) => s.decision.outcome !== "not_triggered")
      .map((s) => ({
        key: s.instance.key,
        date: s.instance.date,
        ruleId: s.instance.ruleId,
        recipientId: s.instance.recipientId,
        kind: s.instance.kind,
        amountCents: s.instance.amountCents,
        outcome: s.decision.outcome,
        runningCents: s.totalsAfter[capId] ?? 0,
      })),
    capId,
    totalCents: sim.totals[capId] ?? 0,
    limitCents: cap.limitCents,
    replayConfirmed: true,
    refusedGuaranteed: enforced.refusedGuaranteed.map((s) => ({
      ruleId: s.instance.ruleId,
      date: s.instance.date,
      amountCents: s.instance.amountCents,
    })),
  };
}

// ---------------------------------------------------------------------------
// Checks

interface Counter {
  checks: number;
}

const TIMEOUT_MS = 15_000;

async function capCheck(
  Z: Z3Ctx,
  ruleset: Ruleset,
  plan: MonthPlan,
  cap: CapRuleT,
  counter: Counter,
): Promise<{ status: "proved" | "unknown" } | { status: "broken"; events: Set<string> }> {
  const s = new Z.Solver();
  s.set("timeout", TIMEOUT_MS);
  const enc = encodeMonth(Z, ruleset, plan, { enforce: false });
  s.add(...enc.facts);
  s.add(enc.totals[cap.id].gt(cap.limitCents));
  counter.checks++;
  const r = await s.check();
  if (r === "unsat") return { status: "proved" };
  if (r === "unknown") return { status: "unknown" };
  return { status: "broken", events: trueEvents(Z, s.model(), plan, enc) };
}

async function worstCase(Z: Z3Ctx, ruleset: Ruleset, plan: MonthPlan, cap: CapRuleT, counter: Counter, fewestEvents = false) {
  const o = new Z.Optimize();
  o.set("timeout", TIMEOUT_MS);
  const enc = encodeMonth(Z, ruleset, plan, { enforce: false });
  o.add(...enc.facts);
  o.maximize(enc.totals[cap.id]);
  const evs = [...enc.events.values()];
  if (fewestEvents && evs.length) o.minimize(Z.Sum(Z.If(evs[0], 1, 0), ...evs.slice(1).map((e) => Z.If(e, 1, 0))));
  counter.checks++;
  const r = await o.check();
  if (r !== "sat") return null;
  const model = o.model();
  return { total: intValue(Z, model, enc.totals[cap.id]), events: trueEvents(Z, model, plan, enc) };
}

async function guaranteeCheck(
  Z: Z3Ctx,
  ruleset: Ruleset,
  plan: MonthPlan,
  counter: Counter,
): Promise<{ status: "proved" | "unknown" | "none" } | { status: "broken"; events: Set<string> }> {
  const guaranteed = plan.instances.filter((i) => i.guaranteed);
  if (!guaranteed.length) return { status: "none" };
  if (!plan.caps.length) return { status: "proved" };
  const s = new Z.Solver();
  s.set("timeout", TIMEOUT_MS);
  const enc = encodeMonth(Z, ruleset, plan, { enforce: true });
  s.add(...enc.facts);
  s.add(Z.Or(...guaranteed.map((g) => enc.refused[g.idx])));
  counter.checks++;
  const r = await s.check();
  if (r === "unsat") return { status: "proved" };
  if (r === "unknown") return { status: "unknown" };
  return { status: "broken", events: trueEvents(Z, s.model(), plan, enc) };
}

/**
 * Unsat core: with the counterexample's events fixed, assert every rule (each
 * behind its own tracking literal) plus the property as a requirement. That is
 * unsatisfiable; the core names the rules that collide. We then shrink it to a
 * minimal core: drop any one of these rules and the collision disappears.
 */
async function collisionCore(
  Z: Z3Ctx,
  ruleset: Ruleset,
  plan: MonthPlan,
  events: Set<string>,
  property: "cap" | "guarantee",
  counter: Counter,
): Promise<string[]> {
  const lits = new Map<string, Bool<"main">>();
  const lit = (ruleId: string) => {
    let l = lits.get(ruleId);
    if (!l) {
      l = Z.Bool.const(`rule__${ruleId}`);
      lits.set(ruleId, l);
    }
    return l;
  };
  const enc = encodeMonth(Z, ruleset, plan, { enforce: property === "guarantee", fixedEvents: events, lit });
  const s = new Z.Solver();
  s.set("timeout", TIMEOUT_MS);
  s.add(...enc.facts);
  if (property === "cap") {
    for (const cap of plan.caps) s.add(Z.Implies(lit(cap.id), enc.totals[cap.id].le(cap.limitCents)));
  } else {
    for (const inst of plan.instances) {
      if (inst.guaranteed) s.add(Z.Implies(lit(inst.ruleId), Z.Not(enc.refused[inst.idx])));
    }
  }
  const all = [...lits.entries()];
  counter.checks++;
  if ((await s.check(...all.map(([, l]) => l))) !== "unsat") return [];
  const coreNames = new Set([...s.unsatCore().values()].map((b) => b.toString()));
  let core = all.filter(([id]) => coreNames.has(`rule__${id}`) || coreNames.has(`|rule__${id}|`));
  // Deletion-based minimisation.
  for (const candidate of [...core]) {
    const without = core.filter(([id]) => id !== candidate[0]);
    counter.checks++;
    if ((await s.check(...without.map(([, l]) => l))) === "unsat") core = without;
  }
  const order = ruleset.rules.map((r) => r.id);
  return core.map(([id]) => id).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// ---------------------------------------------------------------------------
// Public API

export interface VerifyInput {
  ruleset: Ruleset;
  start: IsoDate;
  months?: number;
  history?: readonly HistoryEntry[];
  /** Share one proof between months with the same shape (default true). */
  dedupe?: boolean;
}

/**
 * Two months with the same shape have exactly the same set of reachable
 * outcomes, so one Z3 proof covers both. The shape is the ordered sequence of
 * payment instances, where a run of k identical extras-only days is cut to
 * min(k, sum of those extras' monthly maximums): only paid events change the
 * state, and at most that many can be paid in the run. Prior history is part
 * of the shape. A test checks dedupe on/off gives identical verdicts.
 */
export function monthShape(plan: MonthPlan): string {
  const days: { tokens: string; extrasOnly: boolean; room: number }[] = [];
  let cur: { date: string; ids: string[]; extrasOnly: boolean; room: number } | null = null;
  const flush = () => {
    if (cur) days.push({ tokens: cur.ids.join(","), extrasOnly: cur.extrasOnly, room: cur.room });
  };
  for (const inst of plan.instances) {
    if (!cur || cur.date !== inst.date) {
      flush();
      cur = { date: inst.date, ids: [], extrasOnly: true, room: 0 };
    }
    cur.ids.push(`${inst.ruleId}:${inst.amountCents}`);
    if (inst.kind !== "extra") cur.extrasOnly = false;
    else cur.room += inst.maxPerMonth ?? 0;
  }
  flush();
  const out: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j < days.length && days[j].extrasOnly && days[i].extrasOnly && days[j].tokens === days[i].tokens) j++;
    if (j > i + 1) {
      out.push(`${days[i].tokens}×${Math.min(j - i, days[i].room)}`);
      i = j;
    } else {
      out.push(days[i].tokens);
      i++;
    }
  }
  return JSON.stringify([out, plan.priorByCap, plan.priorExtraCount]);
}

interface ShapeResult {
  month: IsoMonth;
  caps: CapMonthResult[];
  guarantee: MonthReport["guarantee"];
  brokenRules: string[];
}

export async function verify(Z: Z3Ctx, input: VerifyInput): Promise<VerifyReport> {
  const t0 = Date.now();
  const counter: Counter = { checks: 0 };
  const { ruleset } = input;
  const dedupe = input.dedupe ?? true;
  const horizon = buildHorizon(ruleset, input.start, input.months ?? 12, input.history ?? []);
  const caps = ruleset.rules.filter((r): r is CapRuleT => r.kind === "cap");
  const guaranteedRules = ruleset.rules.filter((r) => r.kind === "recurring" && r.guarantee === "guaranteed");
  const months: MonthReport[] = [];
  const shapes = new Map<string, ShapeResult>();
  let failure: VerifyReport["failure"] = null;
  const brokenFirst = new Map<string, IsoMonth>();
  let booleans = 0;

  for (const plan of horizon.months) {
    booleans += plan.instances.filter((i) => i.kind === "extra").length;
    const key = monthShape(plan);
    let shape = dedupe ? shapes.get(key) : undefined;
    const reused = shape !== undefined;

    if (!shape) {
      const capResults: CapMonthResult[] = [];
      const brokenRules: string[] = [];
      for (const cap of caps) {
        const res = await capCheck(Z, ruleset, plan, cap, counter);
        let worst = await worstCase(Z, ruleset, plan, cap, counter);
        capResults.push({ capId: cap.id, limitCents: cap.limitCents, worstCaseCents: worst?.total ?? 0, status: res.status });
        if (res.status !== "broken") continue;
        brokenRules.push(cap.id);
        if (!failure) {
          // Tell the story with the worst case (highest total, then fewest events).
          worst = (await worstCase(Z, ruleset, plan, cap, counter, true)) ?? worst;
          const pick = worst && worst.total > cap.limitCents ? worst.events : res.events;
          const breaks = (sim: MonthSimulation) => (sim.totals[cap.id] ?? 0) > cap.limitCents;
          const { sim, events } = replay(ruleset, plan, pick, breaks, false);
          const cx = toCounterexample(ruleset, plan, sim, events, { kind: "cap", capId: cap.id }, cap.id);
          const core = await collisionCore(Z, ruleset, plan, events, "cap", counter);
          failure = { month: plan.month, counterexample: cx, core };
        }
      }
      const g = await guaranteeCheck(Z, ruleset, plan, counter);
      if (g.status === "broken") {
        const refusedCheck = (sim: MonthSimulation) => sim.refusedGuaranteed.length > 0;
        const { sim, events } = replay(ruleset, plan, g.events, refusedCheck, true);
        const first = sim.refusedGuaranteed[0];
        brokenRules.push(...new Set(sim.refusedGuaranteed.map((s) => s.instance.ruleId)));
        if (!failure) {
          const cx = toCounterexample(
            ruleset,
            plan,
            sim,
            events,
            { kind: "guarantee", ruleId: first.instance.ruleId, date: first.instance.date },
            first.decision.capId as string,
          );
          const core = await collisionCore(Z, ruleset, plan, events, "guarantee", counter);
          failure = { month: plan.month, counterexample: cx, core };
        }
      }
      shape = { month: plan.month, caps: capResults, guarantee: g.status, brokenRules };
      shapes.set(key, shape);
    }

    for (const id of shape.brokenRules) if (!brokenFirst.has(id)) brokenFirst.set(id, plan.month);
    months.push({
      month: plan.month,
      label: monthName(plan.month),
      from: plan.from,
      caps: shape.caps,
      guarantee: shape.guarantee,
      guaranteedCount: plan.instances.filter((i) => i.guaranteed).length,
      uncertainEvents: plan.instances.filter((i) => i.kind === "extra").length,
      sameShapeAs: reused ? shape.month : null,
    });
  }

  const anyUnknown = months.some((m) => m.guarantee === "unknown" || m.caps.some((c) => c.status === "unknown"));
  const status = (id: string, unknown: boolean) =>
    brokenFirst.has(id) ? ("broken" as const) : unknown ? ("unknown" as const) : ("proved" as const);
  const properties: PropertySummary[] = [
    ...caps.map((c) => ({
      id: `cap:${c.id}`,
      kind: "cap" as const,
      ruleId: c.id,
      status: status(c.id, months.some((m) => m.caps.find((x) => x.capId === c.id)?.status === "unknown")),
      firstBrokenMonth: brokenFirst.get(c.id) ?? null,
    })),
    ...guaranteedRules.map((r) => ({
      id: `guarantee:${r.id}`,
      kind: "guarantee" as const,
      ruleId: r.id,
      status: status(r.id, months.some((m) => m.guarantee === "unknown")),
      firstBrokenMonth: brokenFirst.get(r.id) ?? null,
    })),
  ];

  return {
    verdict: failure ? "counterexample" : anyUnknown ? "unknown" : "verified",
    horizon: { start: horizon.start, end: horizon.end, months: horizon.months.length },
    months,
    properties,
    failure,
    stats: { checks: counter.checks, ms: Date.now() - t0, booleans, shapes: shapes.size || months.length },
  };
}

/**
 * Fast yes/no used by the repair search: every cap holds in every month of
 * the horizon. Caps holding implies no guaranteed payment is ever refused
 * (amounts are positive, so a running total never exceeds the final total),
 * so the guarantee query is skipped here; a test checks that implication.
 * Checks the `hintMonth` first, where a failure is likeliest, and shares
 * proofs between months of the same shape. The full `verify` runs both
 * properties when a repair is applied.
 */
export async function holds(
  Z: Z3Ctx,
  input: VerifyInput & { hintMonth?: IsoMonth },
  counter: Counter = { checks: 0 },
): Promise<boolean> {
  const { ruleset } = input;
  const horizon = buildHorizon(ruleset, input.start, input.months ?? 12, input.history ?? []);
  const caps = ruleset.rules.filter((r): r is CapRuleT => r.kind === "cap");
  if (!caps.length) return true;
  const plans = [...horizon.months].sort((a, b) =>
    a.month === input.hintMonth ? -1 : b.month === input.hintMonth ? 1 : 0,
  );
  const seen = new Set<string>();
  for (const plan of plans) {
    const key = monthShape(plan);
    if (seen.has(key)) continue;
    seen.add(key);
    const s = new Z.Solver();
    s.set("timeout", TIMEOUT_MS);
    const enc = encodeMonth(Z, ruleset, plan, { enforce: false });
    s.add(...enc.facts);
    s.add(Z.Or(...caps.map((c) => enc.totals[c.id].gt(c.limitCents))));
    counter.checks++;
    if ((await s.check()) !== "unsat") return false;
  }
  return true;
}

export const __test = { capCheck, worstCase, guaranteeCheck, collisionCore, encodeMonth };
