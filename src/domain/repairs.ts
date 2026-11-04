import type { IsoDate, IsoMonth } from "@/lib/calendar";
import type { Cents } from "@/lib/money";
import { describeRule } from "./english";
import type { HistoryEntry } from "./plan";
import { isSkippable, parseRuleset, ruleById, type Rule, type Ruleset } from "./rules";
import { holds, type VerifyReport, type Z3Ctx } from "./verify";

/**
 * Repairs for a failed verification. Structural fixes first (add a skip
 * rule), then the largest safe amount for each colliding payment and the
 * smallest safe cap, each found by binary search with repeated Z3 checks.
 * Every repair offered has passed `holds` — it is re-verified in full when
 * the person applies it.
 */

export interface Repair {
  id: string;
  kind: "add_skip" | "lower_amount" | "raise_cap";
  title: string;
  /** Template English for the changed or added rule. */
  text: string;
  ruleset: Ruleset;
  checks: number;
  ruleId: string;
  fromCents?: Cents;
  toCents?: Cents;
}

interface Ctx {
  Z: Z3Ctx;
  start: IsoDate;
  history: readonly HistoryEntry[];
  hintMonth: IsoMonth;
}

function withRule(rs: Ruleset, ruleId: string, patch: (r: Rule) => Rule): Ruleset {
  return { ...rs, rules: rs.rules.map((r) => (r.id === ruleId ? patch(r) : r)) };
}

async function check(ctx: Ctx, rs: Ruleset, counter: { checks: number }): Promise<boolean> {
  return holds(ctx.Z, { ruleset: rs, start: ctx.start, history: ctx.history, hintMonth: ctx.hintMonth }, counter);
}

/**
 * Largest x in [lo, hi] with ok(x), assuming ok is monotone (true then false).
 * Returns null when even lo fails.
 */
export async function largestSafe(
  lo: number,
  hi: number,
  ok: (x: number) => Promise<boolean>,
  hint?: number,
): Promise<number | null> {
  if (lo > hi) return null;
  // Probe the arithmetic estimate first: when it is exact, two checks settle it.
  if (hint !== undefined && hint >= lo && hint <= hi) {
    if (await ok(hint)) {
      if (hint === hi || !(await ok(hint + 1))) return hint;
      lo = hint + 1;
    } else hi = hint - 1;
    if (lo > hi) return null;
  }
  if (!(await ok(lo))) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (await ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Smallest x in [lo, hi] with ok(x), assuming ok is monotone (false then true). */
export async function smallestSafe(
  lo: number,
  hi: number,
  ok: (x: number) => Promise<boolean>,
  hint?: number,
): Promise<number | null> {
  if (lo > hi) return null;
  if (hint !== undefined && hint >= lo && hint <= hi) {
    if (await ok(hint)) {
      if (hint === lo || !(await ok(hint - 1))) return hint;
      hi = hint - 1;
    } else lo = hint + 1;
    if (lo > hi) return null;
  }
  if (!(await ok(hi))) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export async function suggestRepairs(
  Z: Z3Ctx,
  input: { ruleset: Ruleset; start: IsoDate; history?: readonly HistoryEntry[]; report: VerifyReport },
): Promise<Repair[]> {
  const { ruleset, report } = input;
  if (!report.failure) return [];
  const ctx: Ctx = { Z, start: input.start, history: input.history ?? [], hintMonth: report.failure.month };
  const capId = report.failure.counterexample.capId;
  const core = report.failure.core;
  const repairs: Repair[] = [];

  // 1. Structural: skip a skippable payment in months where it would break the cap.
  const targeted = new Set(ruleset.rules.flatMap((r) => (r.kind === "skip" ? [r.targetRuleId] : [])));
  const skippables = core
    .map((id) => ruleById(ruleset, id))
    .filter((r): r is Rule => !!r && isSkippable(r) && !targeted.has(r.id))
    .sort((a, b) => (a.kind === "extra" ? -1 : 0) - (b.kind === "extra" ? -1 : 0));
  for (const target of skippables) {
    const counter = { checks: 0 };
    const skip: Rule = { kind: "skip", id: `skip-${target.id}`.slice(0, 48), targetRuleId: target.id, capId };
    const candidate = parseRuleset({ ...ruleset, rules: [...ruleset.rules, skip] });
    if (await check(ctx, candidate, counter)) {
      repairs.push({
        id: `add_skip:${target.id}`,
        kind: "add_skip",
        title: "Add a skip rule",
        text: describeRule(candidate, skip),
        ruleset: candidate,
        checks: counter.checks,
        ruleId: skip.id,
      });
    }
  }

  // 2. Largest safe amount for each colliding payment (to the dollar when it is whole dollars).
  for (const id of core) {
    const rule = ruleById(ruleset, id);
    if (!rule || (rule.kind !== "recurring" && rule.kind !== "extra")) continue;
    const unit = rule.amountCents % 100 === 0 ? 100 : 1;
    const counter = { checks: 0 };
    const at = (units: number) => withRule(ruleset, id, (r) => ({ ...r, amountCents: units * unit }) as Rule);
    // Estimate: the excess spread over the payment's occurrences in the failing month.
    const cx = report.failure.counterexample;
    const n = Math.max(1, cx.steps.filter((s) => s.ruleId === id && s.outcome === "paid").length);
    const hint = Math.floor((rule.amountCents - Math.ceil((cx.totalCents - cx.limitCents) / n)) / unit);
    const best = await largestSafe(1, rule.amountCents / unit - 1, (u) => check(ctx, at(u), counter), hint);
    if (best === null) continue;
    const candidate = at(best);
    repairs.push({
      id: `lower_amount:${id}`,
      kind: "lower_amount",
      title: "Largest safe amount",
      text: describeRule(candidate, ruleById(candidate, id) as Rule),
      ruleset: candidate,
      checks: counter.checks,
      ruleId: id,
      fromCents: rule.amountCents,
      toCents: best * unit,
    });
  }

  // 3. Smallest safe cap.
  const cap = ruleById(ruleset, capId);
  if (cap && cap.kind === "cap") {
    const unit = cap.limitCents % 100 === 0 ? 100 : 1;
    const worst = Math.max(...report.months.flatMap((m) => m.caps.filter((c) => c.capId === capId).map((c) => c.worstCaseCents)));
    const counter = { checks: 0 };
    const at = (units: number) => withRule(ruleset, capId, (r) => ({ ...r, limitCents: units * unit }) as Rule);
    const lo = cap.limitCents / unit + 1;
    const hi = Math.max(lo, Math.ceil(worst / unit));
    const best = await smallestSafe(lo, hi, (u) => check(ctx, at(u), counter), Math.ceil(worst / unit));
    if (best !== null) {
      const candidate = at(best);
      repairs.push({
        id: `raise_cap:${capId}`,
        kind: "raise_cap",
        title: "Smallest safe cap",
        text: describeRule(candidate, ruleById(candidate, capId) as Rule),
        ruleset: candidate,
        checks: counter.checks,
        ruleId: capId,
        fromCents: cap.limitCents,
        toCents: best * unit,
      });
    }
  }
  return repairs;
}
