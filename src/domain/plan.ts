import {
  addMonths,
  daysInMonth,
  eachDay,
  firstOfMonth,
  iso,
  lastOfMonth,
  monthOf,
  monthParts,
  weekday,
  type IsoDate,
  type IsoMonth,
} from "@/lib/calendar";
import type { Cents } from "@/lib/money";
import type { CapRuleT, Rule, Ruleset, SkipRuleT } from "./rules";
import { capsFor } from "./rules";

/**
 * The calendar, computed in TypeScript. Expands a ruleset into, for each
 * calendar month of the horizon, the ordered list of payment instances that
 * could happen. Both the Z3 encoding and the simulator consume this plan, so
 * they can never disagree about which days are Fridays.
 */

export type PaymentKind = "recurring" | "extra" | "one_off";

export interface Instance {
  /** Position in the month's order. */
  idx: number;
  /** ruleId@date — also the identity of an uncertain event. */
  key: string;
  ruleId: string;
  kind: PaymentKind;
  date: IsoDate;
  recipientId: string;
  amountCents: Cents;
  guaranteed: boolean;
  /** Extras only: the monthly maximum. */
  maxPerMonth: number | null;
  /** Caps this payment counts towards. */
  capIds: string[];
  /** Skip rules targeting this payment, with the caps each one protects here. */
  skips: { skipRuleId: string; capIds: string[] }[];
  /** Non-skippable scheduled payments always go out (unless a cap refuses them). */
  fixed: boolean;
  /** For each cap: sum of fixed payments after this one in the same month. */
  fixedAfter: Record<string, Cents>;
}

/** Actual payments already made (from payout history). */
export interface HistoryEntry {
  date: IsoDate;
  ruleId: string | null;
  recipientId: string;
  amountCents: Cents;
}

export interface MonthPlan {
  month: IsoMonth;
  from: IsoDate;
  to: IsoDate;
  instances: Instance[];
  caps: CapRuleT[];
  /** Paid earlier in this month, before `from`, per cap. */
  priorByCap: Record<string, Cents>;
  /** Extras already paid earlier in this month, per rule. */
  priorExtraCount: Record<string, number>;
}

const KIND_ORDER: Record<string, number> = { one_off: 0, recurring_g: 1, recurring_s: 2, extra: 3 };

function dueDates(rule: Rule, month: IsoMonth): IsoDate[] {
  const { y, m } = monthParts(month);
  if (rule.kind === "recurring") {
    if (rule.schedule.every === "week") {
      const wd = rule.schedule.weekday;
      return eachDay(firstOfMonth(month), lastOfMonth(month)).filter((d) => weekday(d) === wd);
    }
    return [iso(y, m, Math.min(rule.schedule.day, daysInMonth(y, m)))];
  }
  if (rule.kind === "extra") return eachDay(firstOfMonth(month), lastOfMonth(month));
  if (rule.kind === "one_off") return monthOf(rule.date) === month ? [rule.date] : [];
  return [];
}

export function buildMonthPlan(
  ruleset: Ruleset,
  month: IsoMonth,
  from: IsoDate = firstOfMonth(month),
  history: readonly HistoryEntry[] = [],
): MonthPlan {
  const to = lastOfMonth(month);
  const caps = ruleset.rules.filter((r): r is CapRuleT => r.kind === "cap");
  const skipRules = ruleset.rules.filter((r): r is SkipRuleT => r.kind === "skip");
  const raw: Omit<Instance, "idx" | "fixedAfter">[] = [];
  const order: number[] = [];

  ruleset.rules.forEach((rule, ruleIndex) => {
    if (rule.kind !== "recurring" && rule.kind !== "extra" && rule.kind !== "one_off") return;
    const ruleCaps = capsFor(ruleset, rule.recipientId).map((c) => c.id);
    const skips = skipRules
      .filter((s) => s.targetRuleId === rule.id)
      .map((s) => ({ skipRuleId: s.id, capIds: s.capId === null ? ruleCaps : ruleCaps.filter((c) => c === s.capId) }));
    const guaranteed = rule.kind === "recurring" && rule.guarantee === "guaranteed";
    const kindKey = rule.kind === "recurring" ? (guaranteed ? "recurring_g" : "recurring_s") : rule.kind;
    for (const date of dueDates(rule, month)) {
      if (date < from) continue;
      raw.push({
        key: `${rule.id}@${date}`,
        ruleId: rule.id,
        kind: rule.kind,
        date,
        recipientId: rule.recipientId,
        amountCents: rule.amountCents,
        guaranteed,
        maxPerMonth: rule.kind === "extra" ? rule.maxPerMonth : null,
        capIds: ruleCaps,
        skips,
        fixed: rule.kind !== "extra" && skips.length === 0,
      });
      order.push(KIND_ORDER[kindKey] * 1000 + ruleIndex);
    }
  });

  const sorted = raw
    .map((inst, i) => ({ inst, sortKey: order[i] }))
    .sort((a, b) => (a.inst.date < b.inst.date ? -1 : a.inst.date > b.inst.date ? 1 : a.sortKey - b.sortKey))
    .map((x) => x.inst);

  const instances: Instance[] = sorted.map((inst, idx) => ({ ...inst, idx, fixedAfter: {} }));
  for (const cap of caps) {
    let acc = 0;
    for (let i = instances.length - 1; i >= 0; i--) {
      instances[i].fixedAfter[cap.id] = acc;
      if (instances[i].fixed && instances[i].capIds.includes(cap.id)) acc += instances[i].amountCents;
    }
  }

  const priorByCap: Record<string, Cents> = Object.fromEntries(caps.map((c) => [c.id, 0]));
  const priorExtraCount: Record<string, number> = {};
  for (const h of history) {
    if (monthOf(h.date) !== month || h.date >= from) continue;
    for (const cap of capsFor(ruleset, h.recipientId)) priorByCap[cap.id] += h.amountCents;
    if (h.ruleId) priorExtraCount[h.ruleId] = (priorExtraCount[h.ruleId] ?? 0) + 1;
  }

  return { month, from, to, instances, caps, priorByCap, priorExtraCount };
}

export interface Horizon {
  start: IsoDate;
  end: IsoDate;
  months: MonthPlan[];
}

/** 12 calendar months starting with the month containing `start`. */
export function buildHorizon(
  ruleset: Ruleset,
  start: IsoDate,
  monthCount = 12,
  history: readonly HistoryEntry[] = [],
): Horizon {
  const first = monthOf(start);
  const months: MonthPlan[] = [];
  for (let i = 0; i < monthCount; i++) {
    const month = addMonths(first, i);
    months.push(buildMonthPlan(ruleset, month, i === 0 ? start : firstOfMonth(month), history));
  }
  return { start, end: months[months.length - 1].to, months };
}
