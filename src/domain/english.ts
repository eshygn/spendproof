import { WEEKDAYS, formatDate, ordinal } from "@/lib/calendar";
import { formatMoney } from "@/lib/money";
import type { Rule, Ruleset } from "./rules";
import { recipientById, ruleById } from "./rules";

/**
 * Plain English generated from a fixed template — never by the AI model.
 * This is what the person reads and confirms, so it must say exactly what
 * the JSON says and nothing more.
 */

function who(rs: Ruleset, recipientId: string): string {
  return recipientById(rs, recipientId)?.name ?? recipientId;
}

function firstName(rs: Ruleset, recipientId: string): string {
  return who(rs, recipientId).split(" ")[0];
}

const money = (c: number) => formatMoney(c);
const short = (c: number) => formatMoney(c, { currency: false, compact: true });

function capPhrase(rs: Ruleset, capId: string | null): string {
  if (capId === null) return "any spending cap it counts towards";
  const cap = ruleById(rs, capId);
  if (!cap || cap.kind !== "cap") return `cap "${capId}"`;
  return cap.scope.type === "overall"
    ? `the ${short(cap.limitCents)} monthly total cap`
    : `the ${short(cap.limitCents)} monthly cap for ${firstName(rs, cap.scope.recipientId)}`;
}

function targetPhrase(rs: Ruleset, ruleId: string): string {
  const r = ruleById(rs, ruleId);
  if (!r) return `rule "${ruleId}"`;
  if (r.kind === "extra") return `${firstName(rs, r.recipientId)}'s ${short(r.amountCents)} extra for "${r.trigger}"`;
  if (r.kind === "recurring") return `${firstName(rs, r.recipientId)}'s ${short(r.amountCents)} ${scheduleShort(r)} payment`;
  return ruleTitle(rs, r);
}

function scheduleShort(r: Extract<Rule, { kind: "recurring" }>): string {
  return r.schedule.every === "week" ? WEEKDAYS[r.schedule.weekday] : `${ordinal(r.schedule.day)}-of-the-month`;
}

export function describeRule(rs: Ruleset, rule: Rule): string {
  switch (rule.kind) {
    case "recurring": {
      const when =
        rule.schedule.every === "week"
          ? `every ${WEEKDAYS[rule.schedule.weekday]}`
          : rule.schedule.day >= 29
            ? `on the ${ordinal(rule.schedule.day)} of every month (or the last day of shorter months)`
            : `on the ${ordinal(rule.schedule.day)} of every month`;
      const purpose = rule.purpose ? ` for ${rule.purpose}` : "";
      const g =
        rule.guarantee === "guaranteed"
          ? "Guaranteed: it must never be skipped."
          : "Skippable: a skip rule may drop it.";
      return `Send ${who(rs, rule.recipientId)} ${money(rule.amountCents)} ${when}${purpose}. ${g}`;
    }
    case "extra":
      return `Send ${who(rs, rule.recipientId)} an extra ${money(rule.amountCents)} each time "${rule.trigger}" happens, at most ${rule.maxPerMonth} ${rule.maxPerMonth === 1 ? "time" : "times"} per calendar month.`;
    case "cap":
      return rule.scope.type === "overall"
        ? `Never send more than ${money(rule.limitCents)} in total in any calendar month.`
        : `Never send ${who(rs, rule.scope.recipientId)} more than ${money(rule.limitCents)} in any calendar month.`;
    case "skip":
      return `Skip ${targetPhrase(rs, rule.targetRuleId)} in any month where paying it would break ${capPhrase(rs, rule.capId)}.`;
    case "approved_recipients":
      return `Only ever pay approved recipients: ${rule.recipientIds.map((r) => who(rs, r)).join(", ")}.`;
    case "approval":
      return `Any one-off payment over ${money(rule.overCents)} needs your approval first.`;
    case "one_off":
      return `Send ${who(rs, rule.recipientId)} ${money(rule.amountCents)} once, on ${formatDate(rule.date, { weekday: true, year: true })}${rule.purpose ? ` for ${rule.purpose}` : ""}.`;
  }
}

/** A short name for chips, cores and gatekeeper verdicts. */
export function ruleTitle(rs: Ruleset, rule: Rule): string {
  switch (rule.kind) {
    case "recurring":
      return rule.schedule.every === "week"
        ? `${firstName(rs, rule.recipientId)}'s ${short(rule.amountCents)} ${WEEKDAYS[rule.schedule.weekday]}s${rule.guarantee === "guaranteed" ? " (guaranteed)" : ""}`
        : `${firstName(rs, rule.recipientId)}'s ${short(rule.amountCents)} on the ${ordinal(rule.schedule.day)}`;
    case "extra":
      return `${firstName(rs, rule.recipientId)}'s ${short(rule.amountCents)} ${rule.purpose || `"${rule.trigger}"`} extras`;
    case "cap":
      return rule.scope.type === "overall"
        ? `${short(rule.limitCents)} monthly total cap`
        : `${short(rule.limitCents)} monthly cap for ${firstName(rs, rule.scope.recipientId)}`;
    case "skip":
      return `Skip rule for ${targetPhrase(rs, rule.targetRuleId)}`;
    case "approved_recipients":
      return "Approved recipients";
    case "approval":
      return `Approval over ${short(rule.overCents)}`;
    case "one_off":
      return `${firstName(rs, rule.recipientId)}'s ${short(rule.amountCents)} one-off`;
  }
}

export function describeRuleset(rs: Ruleset): { id: string; kind: Rule["kind"]; title: string; text: string }[] {
  return rs.rules.map((r) => ({ id: r.id, kind: r.kind, title: ruleTitle(rs, r), text: describeRule(rs, r) }));
}
