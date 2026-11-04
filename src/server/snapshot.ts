import "server-only";
import { describeRuleset } from "@/domain/english";
import type { Verdict } from "@/domain/gatekeeper";
import { aiStatus } from "./adapters/ai";
import { paypal, paypalClientId } from "./adapters/paypal";
import { db, getMeta } from "./db";
import {
  activeRuleset,
  balanceCents,
  clock,
  horizonStart,
  latestDraft,
  latestVerification,
  payouts,
  pollPayouts,
  type RulesetRow,
} from "./service";
import { z3 } from "./z3";

function withEnglish(row: RulesetRow | null) {
  if (!row) return null;
  const ver = latestVerification(row.id);
  return {
    ...row,
    english: describeRuleset(row.ruleset),
    verification: ver && ver.hash === row.hash ? { ...ver } : null,
  };
}

export async function snapshot() {
  await pollPayouts();
  const pp = await paypal();
  const z = await z3();
  const conn = db();
  const batches = conn.prepare("SELECT id, sender_batch_id, paypal_batch_id, date, status, mode, error, polls FROM batches ORDER BY id").all() as {
    id: number; sender_batch_id: string; paypal_batch_id: string | null; date: string; status: string; mode: string; error: string | null; polls: number;
  }[];
  const proposals = conn.prepare("SELECT * FROM proposals ORDER BY id DESC").all() as {
    id: number; agent_run_id: number; payee_name: string; payee_email: string; amount_cents: number; reason: string; quoted: string;
    verdict: string; status: string; payout_id: number | null; created_on: string;
  }[];
  const runs = conn.prepare("SELECT * FROM agent_runs ORDER BY id DESC").all() as {
    id: number; message_id: string | null; input: string; reply: string; mode: string; created_on: string;
  }[];
  return {
    clock: clock(),
    horizonStart: horizonStart(),
    lastProcessed: getMeta("last_processed") || null,
    failNextBatch: getMeta("fail_next_batch") === "1",
    modes: {
      paypal: { mode: pp.mode, reason: pp.reason },
      ai: aiStatus(),
      z3: { version: z.version },
    },
    paypalClientId: await paypalClientId(),
    draft: withEnglish(latestDraft()),
    active: withEnglish(activeRuleset()),
    balanceCents: balanceCents(),
    payouts: payouts().map((p) => ({
      id: p.id,
      date: p.date,
      ruleId: p.rule_id,
      instanceKey: p.instance_key,
      recipientName: p.recipient_name,
      receiver: p.receiver,
      amountCents: p.amount_cents,
      currency: p.currency,
      source: p.source,
      rulesHash: p.rules_hash,
      status: p.status,
      batchId: p.batch_id,
      payoutItemId: p.payout_item_id,
      transactionId: p.transaction_id,
      error: p.error ? JSON.parse(p.error) : null,
      retryOf: p.retry_of,
      retriedBy: p.retried_by,
      verdict: JSON.parse(p.verdict) as Verdict,
    })),
    batches: batches.map((b) => ({ ...b, error: b.error ? JSON.parse(b.error) : null })),
    skips: conn.prepare("SELECT id, date, instance_key AS instanceKey, rule_id AS ruleId, rules_hash AS rulesHash FROM skips ORDER BY id").all(),
    agentRuns: runs.map((r) => ({
      ...r,
      proposals: proposals
        .filter((p) => p.agent_run_id === r.id)
        .map((p) => ({ ...p, verdict: JSON.parse(p.verdict) as Verdict })),
    })),
    messages: conn.prepare("SELECT id, channel, sender, sender_address AS senderAddress, subject, received_on AS receivedOn, body, raw FROM messages ORDER BY rowid").all(),
    events: conn.prepare("SELECT id, rule_trigger AS trigger, date, note, source FROM events ORDER BY date").all(),
    fundings: conn.prepare("SELECT id, order_id AS orderId, amount_cents AS amountCents, status, mode, payer, date FROM fundings ORDER BY id").all(),
    activity: conn.prepare("SELECT id, date, kind, text FROM activity ORDER BY id DESC LIMIT 60").all(),
  };
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
