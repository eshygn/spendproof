import { createHash } from "node:crypto";
import type { HistoryEntry } from "./plan";
import { canonicalJson, type Ruleset } from "./rules";

/**
 * Identity of a verification: everything the proof depends on and nothing
 * else. Recipient names and PayPal emails are left out on purpose (they never
 * enter the encoding), so sandbox email overrides don't change the key.
 * Bump VERIFIER_VERSION whenever the encoding or the simulator semantics
 * change; the stored-proof test also recomputes every stored proof.
 */
export const VERIFIER_VERSION = "2026-11-04.2";

export interface ProofInput {
  ruleset: Ruleset;
  start: string;
  months?: number;
  history?: readonly HistoryEntry[];
}

export function proofKey(input: ProofInput): string {
  const material = canonicalJson({
    verifier: VERIFIER_VERSION,
    rules: input.ruleset.rules,
    recipients: input.ruleset.recipients.map((r) => r.id),
    start: input.start,
    months: input.months ?? 12,
    history: (input.history ?? []).map((h) => [h.date, h.ruleId, h.recipientId, h.amountCents]),
  });
  return `pk_${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}
