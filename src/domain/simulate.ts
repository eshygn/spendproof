import type { Cents } from "@/lib/money";
import type { Instance, MonthPlan } from "./plan";
import type { Ruleset } from "./rules";

/**
 * A plain TypeScript simulator of the rules. It is the reference semantics:
 * every Z3 counterexample is replayed here before anyone sees it, and the
 * scheduler uses `decide` to run the rules for real.
 *
 * Semantics, in order, for each payment instance of a month:
 *  1. Extras need their event to happen, and stop after maxPerMonth payments.
 *  2. A skip rule drops a skippable payment when paid-so-far + this payment +
 *     the fixed payments still to come this month would exceed a cap.
 *  3. With enforcement on (the gatekeeper), a payment that would push paid-so-far
 *     over any cap is refused.
 */

export type Outcome = "paid" | "not_triggered" | "over_limit" | "skipped" | "refused";

export interface MonthState {
  paidByCap: Record<string, Cents>;
  extraCount: Record<string, number>;
}

export interface Decision {
  outcome: Outcome;
  /** The cap that caused a skip or refusal, with the total it would have reached. */
  capId?: string;
  wouldReach?: Cents;
  skipRuleId?: string;
}

export function initialState(plan: MonthPlan): MonthState {
  return { paidByCap: { ...plan.priorByCap }, extraCount: { ...plan.priorExtraCount } };
}

function capLimit(ruleset: Ruleset, capId: string): Cents {
  const cap = ruleset.rules.find((r) => r.id === capId);
  if (!cap || cap.kind !== "cap") throw new Error(`unknown cap ${capId}`);
  return cap.limitCents;
}

/** Decide one instance against the current state (pure; does not mutate). */
export function decide(
  ruleset: Ruleset,
  inst: Instance,
  state: MonthState,
  triggered: boolean,
  enforce: boolean,
): Decision {
  if (!triggered) return { outcome: "not_triggered" };
  if (inst.kind === "extra" && (state.extraCount[inst.ruleId] ?? 0) >= (inst.maxPerMonth ?? 0)) {
    return { outcome: "over_limit" };
  }
  for (const skip of inst.skips) {
    for (const capId of skip.capIds) {
      const projected = (state.paidByCap[capId] ?? 0) + inst.amountCents + (inst.fixedAfter[capId] ?? 0);
      if (projected > capLimit(ruleset, capId)) {
        return { outcome: "skipped", capId, wouldReach: projected, skipRuleId: skip.skipRuleId };
      }
    }
  }
  if (enforce) {
    for (const capId of inst.capIds) {
      const after = (state.paidByCap[capId] ?? 0) + inst.amountCents;
      if (after > capLimit(ruleset, capId)) return { outcome: "refused", capId, wouldReach: after };
    }
  }
  return { outcome: "paid" };
}

export function apply(state: MonthState, inst: Instance, decision: Decision): MonthState {
  if (decision.outcome !== "paid") return state;
  const paidByCap = { ...state.paidByCap };
  for (const capId of inst.capIds) paidByCap[capId] = (paidByCap[capId] ?? 0) + inst.amountCents;
  const extraCount = { ...state.extraCount };
  if (inst.kind === "extra") extraCount[inst.ruleId] = (extraCount[inst.ruleId] ?? 0) + 1;
  return { paidByCap, extraCount };
}

export interface SimStep {
  instance: Instance;
  decision: Decision;
  /** Running totals per cap after this step. */
  totalsAfter: Record<string, Cents>;
}

export interface MonthSimulation {
  month: string;
  steps: SimStep[];
  totals: Record<string, Cents>;
  /** Sum of payments made in the month that the plan covers (excluding prior history). */
  paidInPlan: Cents;
  capBreaches: { capId: string; total: Cents; limit: Cents }[];
  refusedGuaranteed: SimStep[];
}

/** Run one month. `events` holds the keys of extras whose event happens. */
export function simulateMonth(
  ruleset: Ruleset,
  plan: MonthPlan,
  events: ReadonlySet<string>,
  opts: { enforce: boolean },
): MonthSimulation {
  let state = initialState(plan);
  const steps: SimStep[] = [];
  let paidInPlan = 0;
  for (const inst of plan.instances) {
    const triggered = inst.kind === "extra" ? events.has(inst.key) : true;
    const decision = decide(ruleset, inst, state, triggered, opts.enforce);
    state = apply(state, inst, decision);
    if (decision.outcome === "paid") paidInPlan += inst.amountCents;
    steps.push({ instance: inst, decision, totalsAfter: { ...state.paidByCap } });
  }
  const capBreaches = plan.caps
    .map((c) => ({ capId: c.id, total: state.paidByCap[c.id] ?? 0, limit: c.limitCents }))
    .filter((b) => b.total > b.limit);
  const refusedGuaranteed = steps.filter((s) => s.instance.guaranteed && s.decision.outcome === "refused");
  return { month: plan.month, steps, totals: state.paidByCap, paidInPlan, capBreaches, refusedGuaranteed };
}
