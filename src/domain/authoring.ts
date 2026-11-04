import { z } from "zod";
import { WEEKDAYS } from "@/lib/calendar";
import { parseRuleset, type Recipient, type Rule, type Ruleset } from "./rules";

/**
 * The AI model never writes rules JSON directly. It fills in this strict,
 * flat tool schema (flat because Gemini function declarations handle plain
 * objects and enums far more reliably than unions), and deterministic code
 * converts it into a validated Ruleset. Anything the model could not express
 * goes into `unsupported`, which the app shows to the person.
 */

const weekdayEnum = z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const cents = z.number().int().positive().describe("Integer US cents. $50 is 5000.");

export const AuthoringInput = z.object({
  recipients: z
    .array(z.object({ name: z.string().min(1).describe("The person's or business's name as written, e.g. Sam") }))
    .describe("Everyone who receives money in these rules."),
  recurringPayments: z.array(
    z.object({
      recipientName: z.string(),
      amountCents: cents,
      frequency: z.enum(["weekly", "monthly"]),
      weekday: weekdayEnum.nullable().describe("For weekly payments; null for monthly."),
      dayOfMonth: z.number().int().min(1).max(31).nullable().describe("For monthly payments; null for weekly."),
      neverSkip: z.boolean().describe("True only if the person said it must never be skipped."),
      purpose: z.string().describe("Short purpose, e.g. groceries; empty if not stated."),
    }),
  ),
  conditionalExtras: z.array(
    z.object({
      recipientName: z.string(),
      amountCents: cents,
      trigger: z.string().describe('The uncertain event in the third person, e.g. "Sam does a big shop".'),
      maxTimesPerMonth: z.number().int().min(1).max(31),
      purpose: z.string(),
    }),
  ),
  spendingCaps: z.array(
    z.object({
      recipientName: z.string().nullable().describe("null for a cap on total spending across everyone."),
      limitCentsPerMonth: cents,
    }),
  ),
  skipRules: z
    .array(
      z.object({
        recipientName: z.string(),
        paymentType: z.enum(["conditional_extra", "recurring"]),
        protectsCapOf: z.string().nullable().describe("Recipient name of the cap it protects, or null for the total cap."),
      }),
    )
    .describe("Only if the person said to skip a payment in months where it would break a cap."),
  approvalRequiredOverCents: cents.nullable().describe("One-off payments above this need approval; null if not stated."),
  oneOffPayments: z.array(
    z.object({ recipientName: z.string(), amountCents: cents, date: z.string().describe("YYYY-MM-DD"), purpose: z.string() }),
  ),
  unsupported: z
    .array(z.string())
    .describe("Any instruction that cannot be expressed with these fields, quoted. Never drop an instruction silently."),
});
export type AuthoringInputT = z.infer<typeof AuthoringInput>;

export const AUTHORING_TOOL_DESCRIPTION =
  "Record the person's spending rules exactly as stated. Do not invent amounts, recipients, caps or guarantees.";

/** Contacts the app already knows (name -> PayPal account). */
export interface Contact {
  id: string;
  name: string;
  email: string;
  role: string;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export class AuthoringError extends Error {}

export function toRuleset(input: AuthoringInputT, contacts: readonly Contact[]): { ruleset: Ruleset; unsupported: string[] } {
  const recipients: Recipient[] = [];
  const resolve = (name: string): string => {
    const n = name.trim().toLowerCase();
    const known = recipients.find((r) => r.name.toLowerCase() === n || r.name.split(" ")[0].toLowerCase() === n);
    if (known) return known.id;
    const contact = contacts.find((c) => c.name.toLowerCase() === n || c.name.split(" ")[0].toLowerCase() === n);
    const rec: Recipient = contact
      ? { id: contact.id, name: contact.name, email: contact.email, role: contact.role }
      : { id: slug(name) || "payee", name: name.trim(), email: `${slug(name) || "payee"}@spendproof-demo.example`, role: "New payee" };
    recipients.push(rec);
    return rec.id;
  };
  input.recipients.forEach((r) => resolve(r.name));

  const rules: Rule[] = [];
  const used = new Set<string>();
  const uniqueId = (base: string) => {
    let id = base.slice(0, 44) || "rule";
    for (let i = 2; used.has(id); i++) id = `${base.slice(0, 40)}-${i}`;
    used.add(id);
    return id;
  };

  for (const p of input.recurringPayments) {
    const recipientId = resolve(p.recipientName);
    let schedule: Extract<Rule, { kind: "recurring" }>["schedule"];
    if (p.frequency === "weekly") {
      if (!p.weekday) throw new AuthoringError(`Weekly payment to ${p.recipientName} has no weekday`);
      schedule = { every: "week", weekday: weekdayEnum.options.indexOf(p.weekday) };
    } else {
      if (!p.dayOfMonth) throw new AuthoringError(`Monthly payment to ${p.recipientName} has no day of the month`);
      schedule = { every: "month", day: p.dayOfMonth };
    }
    const when = schedule.every === "week" ? WEEKDAYS[schedule.weekday].toLowerCase() : `day-${schedule.day}`;
    rules.push({
      kind: "recurring",
      id: uniqueId(`${recipientId}-${slug(p.purpose) || when}`),
      recipientId,
      amountCents: p.amountCents,
      schedule,
      guarantee: p.neverSkip ? "guaranteed" : "skippable",
      purpose: p.purpose.trim(),
    });
  }
  for (const x of input.conditionalExtras) {
    const recipientId = resolve(x.recipientName);
    const trig = slug(x.purpose || x.trigger.replace(new RegExp(`^${x.recipientName}\\s+(does|did|has|makes)?\\s*(a|an)?\\s*`, "i"), ""));
    rules.push({
      kind: "extra",
      id: uniqueId(`${recipientId}-${trig || "extra"}`),
      recipientId,
      amountCents: x.amountCents,
      trigger: x.trigger.trim(),
      maxPerMonth: x.maxTimesPerMonth,
      purpose: x.purpose.trim(),
    });
  }
  const capIdFor = new Map<string | null, string>();
  for (const c of input.spendingCaps) {
    const recipientId = c.recipientName ? resolve(c.recipientName) : null;
    const id = uniqueId(recipientId ? `cap-${recipientId}` : "cap-total");
    capIdFor.set(recipientId, id);
    rules.push({
      kind: "cap",
      id,
      scope: recipientId ? { type: "recipient", recipientId } : { type: "overall" },
      limitCents: c.limitCentsPerMonth,
    });
  }
  for (const s of input.skipRules) {
    const recipientId = resolve(s.recipientName);
    const kind = s.paymentType === "conditional_extra" ? "extra" : "recurring";
    const target = rules.find((r) => r.kind === kind && r.recipientId === recipientId);
    if (!target) throw new AuthoringError(`Skip rule refers to a ${s.paymentType} payment to ${s.recipientName} that does not exist`);
    const capKey = s.protectsCapOf ? resolve(s.protectsCapOf) : null;
    rules.push({ kind: "skip", id: uniqueId(`skip-${target.id}`), targetRuleId: target.id, capId: capIdFor.get(capKey) ?? null });
  }
  for (const o of input.oneOffPayments) {
    const recipientId = resolve(o.recipientName);
    rules.push({
      kind: "one_off",
      id: uniqueId(`${recipientId}-once-${o.date}`),
      recipientId,
      amountCents: o.amountCents,
      date: o.date,
      purpose: o.purpose.trim(),
    });
  }
  if (input.approvalRequiredOverCents !== null) {
    rules.push({ kind: "approval", id: uniqueId(`approval-over-${Math.round(input.approvalRequiredOverCents / 100)}`), overCents: input.approvalRequiredOverCents });
  }
  // Everyone named in the rules is approved; nobody else.
  rules.push({ kind: "approved_recipients", id: uniqueId("approved"), recipientIds: recipients.map((r) => r.id) });

  return { ruleset: parseRuleset({ currency: "USD", recipients, rules }), unsupported: input.unsupported };
}

// ---------------------------------------------------------------------------
// The untrusted chat agent: it reads messages and can only *propose* payments.

export const ProposePaymentInput = z.object({
  payeeName: z.string().min(1).describe("Who the message asks to pay."),
  payeePaypalEmail: z.string().describe("The PayPal account the message gives for the payee."),
  amountCents: cents,
  reason: z.string().describe("One sentence: why this payment is being proposed."),
  quotedRequest: z.string().describe("The exact words in the message that ask for the payment."),
});
export type ProposePaymentInputT = z.infer<typeof ProposePaymentInput>;

export const AGENT_SYSTEM_PROMPT = `You are Spendproof's inbox assistant. You read emails and messages the person pastes in and help them act on payment requests.
When a message asks for money to be paid, call propose_payment with the payee, their PayPal email as given in the message, the amount and the exact words that asked for it.
You cannot send money yourself: a separate gatekeeper checks every proposal against the person's verified rules.
After any tool calls, reply in two short sentences saying what you proposed and why.`;

export const AUTHORING_SYSTEM_PROMPT = `You convert a person's plain-English spending instructions into the record_rules tool call.
Rules: amounts are integer US cents. "Never skip" or "always" on a recurring payment means neverSkip true; otherwise false.
"Up to N times a month" is maxTimesPerMonth N. A cap on total spending has recipientName null.
"Needs my approval over $X" sets approvalRequiredOverCents. Only add skipRules if the person explicitly asks to skip a payment when it would break a cap.
If any instruction cannot be expressed, quote it in unsupported. Never invent anything that was not said.`;
