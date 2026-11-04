import { z } from "zod";
import { isIsoDate } from "@/lib/calendar";

/**
 * Rules are data. Seven rule kinds, nothing else. Money is integer cents,
 * time is calendar days. Every cross-reference is checked in `parseRuleset`.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "ids are lowercase slugs");
const cents = z.number().int().positive().max(10_000_000); // up to $100,000.00
const isoDate = z.string().refine(isIsoDate, "must be a YYYY-MM-DD date");

export const RecipientSchema = z.object({
  id,
  name: z.string().min(1).max(60),
  /** PayPal receiver (sandbox email). */
  email: z.string().email(),
  role: z.string().max(60).default(""),
});

export const WeeklySchedule = z.object({ every: z.literal("week"), weekday: z.number().int().min(0).max(6) });
/** Day 29–31 in a shorter month falls on that month's last day. */
export const MonthlySchedule = z.object({ every: z.literal("month"), day: z.number().int().min(1).max(31) });

export const RecurringRule = z.object({
  kind: z.literal("recurring"),
  id,
  recipientId: id,
  amountCents: cents,
  schedule: z.discriminatedUnion("every", [WeeklySchedule, MonthlySchedule]),
  guarantee: z.enum(["guaranteed", "skippable"]),
  purpose: z.string().max(80).default(""),
});

export const ExtraRule = z.object({
  kind: z.literal("extra"),
  id,
  recipientId: id,
  amountCents: cents,
  /** The uncertain event, e.g. "Sam does a big shop". */
  trigger: z.string().min(1).max(80),
  maxPerMonth: z.number().int().min(1).max(31),
  purpose: z.string().max(80).default(""),
});

export const CapRule = z.object({
  kind: z.literal("cap"),
  id,
  scope: z.discriminatedUnion("type", [
    z.object({ type: z.literal("overall") }),
    z.object({ type: z.literal("recipient"), recipientId: id }),
  ]),
  limitCents: cents,
});

export const SkipRule = z.object({
  kind: z.literal("skip"),
  id,
  /** A skippable recurring payment or a conditional extra. */
  targetRuleId: id,
  /** The cap it protects; null means any cap the payment counts towards. */
  capId: id.nullable(),
});

export const ApprovedRecipientsRule = z.object({
  kind: z.literal("approved_recipients"),
  id,
  recipientIds: z.array(id).min(1),
});

export const ApprovalRule = z.object({
  kind: z.literal("approval"),
  id,
  /** One-off payments strictly above this need the person's approval. */
  overCents: cents,
});

export const OneOffRule = z.object({
  kind: z.literal("one_off"),
  id,
  recipientId: id,
  amountCents: cents,
  date: isoDate,
  purpose: z.string().max(80).default(""),
});

export const RuleSchema = z.discriminatedUnion("kind", [
  RecurringRule,
  ExtraRule,
  CapRule,
  SkipRule,
  ApprovedRecipientsRule,
  ApprovalRule,
  OneOffRule,
]);

export const RulesetSchema = z.object({
  currency: z.literal("USD"),
  recipients: z.array(RecipientSchema).min(1).max(20),
  rules: z.array(RuleSchema).min(1).max(40),
});

export type Recipient = z.infer<typeof RecipientSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Ruleset = z.infer<typeof RulesetSchema>;
export type RecurringRuleT = z.infer<typeof RecurringRule>;
export type ExtraRuleT = z.infer<typeof ExtraRule>;
export type CapRuleT = z.infer<typeof CapRule>;
export type SkipRuleT = z.infer<typeof SkipRule>;
export type ApprovalRuleT = z.infer<typeof ApprovalRule>;
export type OneOffRuleT = z.infer<typeof OneOffRule>;
export type ApprovedRecipientsRuleT = z.infer<typeof ApprovedRecipientsRule>;
export type PaymentRule = RecurringRuleT | ExtraRuleT | OneOffRuleT;

export function isPaymentRule(rule: Rule): rule is PaymentRule {
  return rule.kind === "recurring" || rule.kind === "extra" || rule.kind === "one_off";
}

/** Can a skip rule target this rule? Guaranteed payments never can. */
export function isSkippable(rule: Rule): rule is RecurringRuleT | ExtraRuleT {
  return (rule.kind === "recurring" && rule.guarantee === "skippable") || rule.kind === "extra";
}

export type RulesetIssue = { path: string; message: string; ruleId?: string };

export class RulesetError extends Error {
  constructor(public issues: RulesetIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  }
}

/** Structural checks beyond the zod shape: references, uniqueness, singletons. */
export function crossCheck(ruleset: Ruleset): RulesetIssue[] {
  const issues: RulesetIssue[] = [];
  const recipientIds = new Set<string>();
  ruleset.recipients.forEach((r, i) => {
    if (recipientIds.has(r.id)) issues.push({ path: `recipients[${i}]`, message: `duplicate recipient id "${r.id}"` });
    recipientIds.add(r.id);
  });
  const ruleIds = new Map<string, Rule>();
  ruleset.rules.forEach((r, i) => {
    if (ruleIds.has(r.id) || recipientIds.has(r.id)) {
      issues.push({ path: `rules[${i}]`, message: `duplicate id "${r.id}"`, ruleId: r.id });
    }
    ruleIds.set(r.id, r);
  });
  const needRecipient = (rid: string, path: string, ruleId: string) => {
    if (!recipientIds.has(rid)) issues.push({ path, message: `unknown recipient "${rid}"`, ruleId });
  };
  const approved = ruleset.rules.filter((r) => r.kind === "approved_recipients");
  const approvals = ruleset.rules.filter((r) => r.kind === "approval");
  if (approved.length > 1) issues.push({ path: "rules", message: "only one approved-recipients rule is allowed" });
  if (approvals.length > 1) issues.push({ path: "rules", message: "only one approval rule is allowed" });
  const approvedSet = approved[0] ? new Set(approved[0].recipientIds) : null;

  ruleset.rules.forEach((r, i) => {
    const path = `rules[${i}]`;
    switch (r.kind) {
      case "recurring":
      case "extra":
      case "one_off":
        needRecipient(r.recipientId, `${path}.recipientId`, r.id);
        if (approvedSet && !approvedSet.has(r.recipientId)) {
          issues.push({ path, message: `pays ${r.recipientId}, who is not an approved recipient`, ruleId: r.id });
        }
        break;
      case "cap":
        if (r.scope.type === "recipient") needRecipient(r.scope.recipientId, `${path}.scope.recipientId`, r.id);
        break;
      case "approved_recipients":
        r.recipientIds.forEach((rid, j) => needRecipient(rid, `${path}.recipientIds[${j}]`, r.id));
        break;
      case "skip": {
        const target = ruleIds.get(r.targetRuleId);
        if (!target) issues.push({ path, message: `skips unknown rule "${r.targetRuleId}"`, ruleId: r.id });
        else if (!isSkippable(target)) {
          issues.push({
            path,
            message:
              target.kind === "recurring"
                ? `"${target.id}" is guaranteed, so it can never be skipped`
                : `"${target.id}" is not a skippable payment`,
            ruleId: r.id,
          });
        }
        if (r.capId !== null) {
          const cap = ruleIds.get(r.capId);
          if (!cap || cap.kind !== "cap") issues.push({ path, message: `"${r.capId}" is not a cap`, ruleId: r.id });
        }
        break;
      }
      case "approval":
        break;
    }
  });
  return issues;
}

export function parseRuleset(input: unknown): Ruleset {
  const parsed = RulesetSchema.safeParse(input);
  if (!parsed.success) {
    throw new RulesetError(
      parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })),
    );
  }
  const issues = crossCheck(parsed.data);
  if (issues.length) throw new RulesetError(issues);
  return parsed.data;
}

export function ruleById(ruleset: Ruleset, ruleId: string): Rule | undefined {
  return ruleset.rules.find((r) => r.id === ruleId);
}

export function recipientById(ruleset: Ruleset, recipientId: string): Recipient | undefined {
  return ruleset.recipients.find((r) => r.id === recipientId);
}

export function capsFor(ruleset: Ruleset, recipientId: string): CapRuleT[] {
  return ruleset.rules.filter(
    (r): r is CapRuleT =>
      r.kind === "cap" && (r.scope.type === "overall" || r.scope.recipientId === recipientId),
  );
}

/** Stable JSON: keys sorted, so the same rules always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
