import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { toRuleset, type Contact } from "@/domain/authoring";
import { describeRule, ruleTitle } from "@/domain/english";
import { countsTowardHistory, evaluatePayout, type GateContext, type PaidRecord, type PayoutRequest, type Verdict } from "@/domain/gatekeeper";
import { buildMonthPlan } from "@/domain/plan";
import { suggestRepairs, type Repair } from "@/domain/repairs";
import { canonicalJson, parseRuleset, type ExtraRuleT, type Ruleset } from "@/domain/rules";
import { verify, type VerifyReport } from "@/domain/verify";
import { addDays, eachDay, formatDate, monthOf } from "@/lib/calendar";
import { formatMoney, fromDecimalString, type Cents } from "@/lib/money";
import { authorRules, readMessage } from "./adapters/ai";
import { paypal } from "./adapters/paypal";
import { db, getMeta, logActivity, setMeta } from "./db";
import { withZ3 } from "./z3";

export function rulesHash(rs: Ruleset): string {
  return `rv_${createHash("sha256").update(canonicalJson(rs)).digest("hex").slice(0, 10)}`;
}

export function clock(): string {
  return getMeta("clock") as string;
}

// ---------------------------------------------------------------------------
// Rulesets

export interface RulesetRow {
  id: number;
  hash: string;
  ruleset: Ruleset;
  source: string;
  prompt: string | null;
  note: string | null;
  unsupported: string[];
  status: "draft" | "active" | "archived";
  confirmed: boolean;
  createdOn: string;
  /** Rule ids added or changed by the repair that produced this draft. */
  changed: string[];
}

type RawRuleset = {
  id: number; hash: string; json: string; source: string; prompt: string | null; note: string | null;
  unsupported: string; status: RulesetRow["status"]; confirmed: number; created_on: string; changed: string | null;
};

function toRow(r: RawRuleset): RulesetRow {
  return {
    id: r.id,
    hash: r.hash,
    ruleset: JSON.parse(r.json),
    source: r.source,
    prompt: r.prompt,
    note: r.note,
    unsupported: JSON.parse(r.unsupported),
    status: r.status,
    confirmed: !!r.confirmed,
    createdOn: r.created_on,
    changed: r.changed ? JSON.parse(r.changed) : [],
  };
}

export function getRuleset(id: number): RulesetRow | null {
  const r = db().prepare("SELECT * FROM rulesets WHERE id = ?").get(id) as RawRuleset | undefined;
  return r ? toRow(r) : null;
}

export function latestDraft(): RulesetRow | null {
  const r = db().prepare("SELECT * FROM rulesets WHERE status = 'draft' ORDER BY id DESC LIMIT 1").get() as RawRuleset | undefined;
  return r ? toRow(r) : null;
}

export function activeRuleset(): RulesetRow | null {
  const r = db().prepare("SELECT * FROM rulesets WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() as RawRuleset | undefined;
  return r ? toRow(r) : null;
}

function insertDraft(
  rs: Ruleset, source: string, prompt: string | null, note: string | null, unsupported: string[], confirmed: boolean, changed: string[] = [],
): RulesetRow {
  const ruleset = parseRuleset(rs);
  // Only one draft at a time.
  db().prepare("UPDATE rulesets SET status = 'archived' WHERE status = 'draft'").run();
  const info = db()
    .prepare(
      "INSERT INTO rulesets (hash, json, source, prompt, note, changed, unsupported, status, confirmed, created_on) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    )
    .run(rulesHash(ruleset), JSON.stringify(ruleset), source, prompt, note, JSON.stringify(changed), JSON.stringify(unsupported), confirmed ? 1 : 0, clock());
  return getRuleset(Number(info.lastInsertRowid)) as RulesetRow;
}

function contacts(): Contact[] {
  return db().prepare("SELECT id, name, email, role FROM contacts ORDER BY rowid").all() as Contact[];
}

export async function authorFromText(text: string) {
  const ai = await authorRules(text);
  const { ruleset, unsupported } = toRuleset(ai.input, contacts());
  const row = insertDraft(ruleset, ai.source === "recorded" ? "recorded" : "ai", text, ai.note, unsupported, false);
  logActivity(clock(), "author", `Rules drafted from plain English (${ai.source === "live" ? ai.model : ai.source}).`);
  return { draft: row, ai: { source: ai.source, model: ai.model, note: ai.note } };
}

export function saveManualDraft(json: unknown) {
  return insertDraft(parseRuleset(json), "manual", null, "Edited as JSON", [], false);
}

export function confirmDraft(id: number) {
  db().prepare("UPDATE rulesets SET confirmed = 1 WHERE id = ? AND status = 'draft'").run(id);
  logActivity(clock(), "confirm", "You confirmed the rules as written in plain English.");
  return getRuleset(id);
}

// ---------------------------------------------------------------------------
// Verification

/** The first day the scheduler has not yet run: verification starts here. */
export function horizonStart(): string {
  const last = getMeta("last_processed");
  const today = clock();
  if (!last) return today;
  const next = addDays(last, 1);
  return next > today ? next : today;
}

export interface VerificationRow {
  id: number;
  rulesetId: number;
  hash: string;
  start: string;
  end: string;
  verdict: VerifyReport["verdict"];
  report: VerifyReport;
  repairs: Repair[] | null;
}

type RawVerification = { id: number; ruleset_id: number; hash: string; start: string; end_date: string; verdict: string; report: string; repairs: string | null };

function toVerification(r: RawVerification): VerificationRow {
  return {
    id: r.id,
    rulesetId: r.ruleset_id,
    hash: r.hash,
    start: r.start,
    end: r.end_date,
    verdict: r.verdict as VerifyReport["verdict"],
    report: JSON.parse(r.report),
    repairs: r.repairs ? JSON.parse(r.repairs) : null,
  };
}

export function latestVerification(rulesetId: number): VerificationRow | null {
  const r = db()
    .prepare("SELECT * FROM verifications WHERE ruleset_id = ? ORDER BY id DESC LIMIT 1")
    .get(rulesetId) as RawVerification | undefined;
  return r ? toVerification(r) : null;
}

export function verificationForHash(hash: string): VerificationRow | null {
  const r = db()
    .prepare("SELECT * FROM verifications WHERE hash = ? ORDER BY id DESC LIMIT 1")
    .get(hash) as RawVerification | undefined;
  return r ? toVerification(r) : null;
}

export async function verifyRuleset(id: number): Promise<VerificationRow> {
  const row = getRuleset(id);
  if (!row) throw new Error("No such ruleset");
  if (!row.confirmed) throw new Error("Confirm the rules first: Spendproof verifies the rules you confirmed.");
  const start = horizonStart();
  const history = paidHistory();
  const report = await withZ3((Z) => verify(Z, { ruleset: row.ruleset, start, history }));
  const info = db()
    .prepare("INSERT INTO verifications (ruleset_id, hash, start, end_date, verdict, report) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, row.hash, start, report.horizon.end, report.verdict, JSON.stringify(report));
  logActivity(
    clock(),
    "verify",
    report.verdict === "verified"
      ? `Z3 verified rules ${row.hash}: every cap holds and no guaranteed payment is skipped, for every possible sequence of events from ${formatDate(start, { year: true })} to ${formatDate(report.horizon.end, { year: true })}.`
      : report.failure
        ? `Z3 found a counterexample in ${report.months.find((m) => m.month === report.failure?.month)?.label}.`
        : "Z3 could not decide within the time limit.",
  );
  return latestVerificationById(Number(info.lastInsertRowid));
}

function latestVerificationById(id: number): VerificationRow {
  return toVerification(db().prepare("SELECT * FROM verifications WHERE id = ?").get(id) as RawVerification);
}

export async function repairsFor(id: number): Promise<Repair[]> {
  const row = getRuleset(id);
  const ver = latestVerification(id);
  if (!row || !ver || !ver.report.failure) return [];
  if (ver.repairs) return ver.repairs;
  const repairs = await withZ3((Z) =>
    suggestRepairs(Z, { ruleset: row.ruleset, start: ver.start, history: paidHistory(), report: ver.report }),
  );
  db().prepare("UPDATE verifications SET repairs = ? WHERE id = ?").run(JSON.stringify(repairs), ver.id);
  return repairs;
}

export async function applyRepair(id: number, repairId: string) {
  const repairs = await repairsFor(id);
  const repair = repairs.find((r) => r.id === repairId);
  if (!repair) throw new Error("That repair is no longer available");
  const old = getRuleset(id) as RulesetRow;
  // Clicking the repair confirms the change shown on it, in template English.
  const row = insertDraft(repair.ruleset, "repair", old.prompt, `${repair.title}: ${repair.text}`, old.unsupported, true, [repair.ruleId]);
  logActivity(clock(), "repair", `Applied repair — ${repair.text}`);
  const verification = await verifyRuleset(row.id);
  return { draft: row, verification };
}

export function activate(id: number) {
  const row = getRuleset(id);
  if (!row || row.status !== "draft") throw new Error("Nothing to activate");
  const ver = latestVerification(id);
  if (!row.confirmed) throw new Error("Confirm the rules first");
  if (!ver || ver.verdict !== "verified" || ver.hash !== row.hash) throw new Error("Only rules Z3 has verified can be activated");
  const tx = db().transaction(() => {
    db().prepare("UPDATE rulesets SET status = 'archived' WHERE status = 'active'").run();
    db().prepare("UPDATE rulesets SET status = 'active' WHERE id = ?").run(id);
    if (!getMeta("last_processed")) setMeta("last_processed", addDays(clock(), -1));
  });
  tx();
  logActivity(clock(), "activate", `Rules ${row.hash} are live. The scheduler will pay them; the gatekeeper checks every payout.`);
  return getRuleset(id);
}

// ---------------------------------------------------------------------------
// History, balance, gatekeeper context

type RawPayout = {
  id: number; date: string; rule_id: string | null; instance_key: string | null; recipient_id: string | null;
  recipient_name: string; receiver: string; amount_cents: number; currency: string; source: string; rules_hash: string;
  verdict: string; status: string; batch_id: number | null; sender_item_id: string; payout_item_id: string | null;
  transaction_id: string | null; error: string | null; retry_of: number | null; retried_by: number | null;
};

export function payouts(): RawPayout[] {
  return db().prepare("SELECT * FROM payouts ORDER BY date ASC, id ASC").all() as RawPayout[];
}

export function paidHistory(): PaidRecord[] {
  return payouts()
    .filter((p) => countsTowardHistory(p.status))
    .map((p) => ({ date: p.date, ruleId: p.rule_id, recipientId: p.recipient_id ?? "unknown", amountCents: p.amount_cents, instanceKey: p.instance_key }));
}

export function balanceCents(): Cents {
  const funded = (db().prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM fundings WHERE status = 'COMPLETED'").get() as { s: number }).s;
  const spent = paidHistory().reduce((s, p) => s + p.amountCents, 0);
  return funded - spent;
}

function eventKeys(rs: Ruleset): Set<string> {
  const rows = db().prepare("SELECT rule_trigger, date FROM events").all() as { rule_trigger: string; date: string }[];
  const extras = rs.rules.filter((r): r is ExtraRuleT => r.kind === "extra");
  const keys = new Set<string>();
  for (const e of rows) {
    const t = e.rule_trigger.toLowerCase();
    for (const x of extras) {
      if (x.trigger.toLowerCase().includes(t) || x.purpose.toLowerCase() === t || x.id === e.rule_trigger) keys.add(`${x.id}@${e.date}`);
    }
  }
  return keys;
}

export function gateContext(): GateContext | null {
  const active = activeRuleset();
  if (!active) return null;
  const ver = verificationForHash(active.hash);
  return {
    ruleset: active.ruleset,
    rulesHash: active.hash,
    verification: ver ? { hash: ver.hash, verdict: ver.verdict, start: ver.start, end: ver.end } : null,
    history: paidHistory(),
    events: eventKeys(active.ruleset),
    balanceCents: balanceCents(),
  };
}

// ---------------------------------------------------------------------------
// PayPal batches

const newId = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

interface QueuedPayout {
  payoutId: number;
  senderItemId: string;
  receiver: string;
  amountCents: Cents;
  note: string;
}

function insertPayout(req: PayoutRequest, verdict: Verdict, status: string, retryOf: number | null = null): QueuedPayout {
  const senderItemId = newId("sp");
  const note = `${req.ruleId ? "Scheduled" : "One-off"} payment · rules ${verdict.rulesHash}`;
  const info = db()
    .prepare(
      `INSERT INTO payouts (date, rule_id, instance_key, recipient_id, recipient_name, receiver, amount_cents, source, rules_hash, verdict, status, sender_item_id, retry_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.date, req.ruleId, verdict.instanceKey, verdict.recipientId, req.recipientName, req.recipientEmail, req.amountCents,
      req.source, verdict.rulesHash, JSON.stringify(verdict), status, senderItemId, retryOf,
    );
  return { payoutId: Number(info.lastInsertRowid), senderItemId, receiver: req.recipientEmail, amountCents: req.amountCents, note };
}

async function sendBatch(date: string, items: QueuedPayout[]) {
  if (!items.length) return null;
  const adapter = await paypal();
  const simulateFailure = getMeta("fail_next_batch") === "1";
  if (simulateFailure) setMeta("fail_next_batch", "0");
  const senderBatchId = `spendproof_${date}_${randomBytes(3).toString("hex")}`;
  const request = {
    senderBatchId,
    emailSubject: "You have a payment from Spendproof",
    emailMessage: "Sent under rules verified by Spendproof.",
    items: items.map((i) => ({ senderItemId: i.senderItemId, receiver: i.receiver, amountCents: i.amountCents, note: i.note })),
    simulateFailure,
  };
  const batchInfo = db()
    .prepare("INSERT INTO batches (sender_batch_id, date, status, mode, request) VALUES (?, ?, 'CREATING', ?, ?)")
    .run(senderBatchId, date, adapter.mode, JSON.stringify(request));
  const batchId = Number(batchInfo.lastInsertRowid);
  db().prepare(`UPDATE payouts SET batch_id = ? WHERE id IN (${items.map(() => "?").join(",")})`).run(batchId, ...items.map((i) => i.payoutId));
  let result;
  try {
    result = await adapter.createBatch(request);
  } catch (e) {
    result = { ok: false as const, status: 0, body: { name: "NETWORK_ERROR", message: (e as Error).message } };
  }
  const total = formatMoney(items.reduce((s, i) => s + i.amountCents, 0));
  if (result.ok) {
    db()
      .prepare("UPDATE batches SET paypal_batch_id = ?, status = ?, response = ? WHERE id = ?")
      .run(result.body.batch_header.payout_batch_id, result.body.batch_header.batch_status, JSON.stringify(result.body), batchId);
    db().prepare("UPDATE payouts SET status = 'pending' WHERE batch_id = ?").run(batchId);
    logActivity(date, "paypal", `PayPal batch ${result.body.batch_header.payout_batch_id} created: ${items.length} payout${items.length > 1 ? "s" : ""}, ${total}.`);
  } else {
    db().prepare("UPDATE batches SET status = 'FAILED', error = ? WHERE id = ?").run(JSON.stringify(result.body), batchId);
    db().prepare("UPDATE payouts SET status = 'failed', error = ? WHERE batch_id = ?").run(JSON.stringify(result.body), batchId);
    logActivity(date, "paypal-failed", `PayPal refused batch ${senderBatchId} (${result.status} ${result.body.name}${simulateFailure ? ", sandbox negative test" : ""}). ${total} not sent — retry available.`);
  }
  return batchId;
}

let lastPoll = 0;

/** Poll PayPal for batches still in flight and copy item statuses onto payouts. */
export async function pollPayouts(force = false) {
  if (!force && Date.now() - lastPoll < 1500) return;
  lastPoll = Date.now();
  const adapter = await paypal();
  const open = db()
    .prepare("SELECT * FROM batches WHERE paypal_batch_id IS NOT NULL AND status IN ('PENDING', 'PROCESSING') ORDER BY id")
    .all() as { id: number; paypal_batch_id: string; mode: string; polls: number }[];
  for (const b of open) {
    if (b.mode !== adapter.mode) continue;
    try {
      const res = await adapter.getBatch(b.paypal_batch_id);
      db().prepare("UPDATE batches SET status = ?, response = ?, polls = polls + 1 WHERE id = ?").run(res.batch_header.batch_status, JSON.stringify(res), b.id);
      for (const item of res.items) {
        const errors = (item as { errors?: unknown }).errors;
        db()
          .prepare("UPDATE payouts SET status = ?, payout_item_id = ?, transaction_id = ?, error = COALESCE(?, error) WHERE batch_id = ? AND sender_item_id = ?")
          .run(
            item.transaction_status.toLowerCase(), item.payout_item_id, item.transaction_id || null,
            errors ? JSON.stringify(errors) : null, b.id, item.payout_item.sender_item_id,
          );
      }
      if (!res.items.length && res.batch_header.batch_status === "SUCCESS") {
        db().prepare("UPDATE payouts SET status = 'success' WHERE batch_id = ? AND status = 'pending'").run(b.id);
      }
    } catch (e) {
      db().prepare("UPDATE batches SET error = ? WHERE id = ?").run(JSON.stringify({ message: (e as Error).message }), b.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler: deterministic code runs the verified rules day by day.

export interface DayRun {
  date: string;
  sent: { ruleId: string; recipient: string; amountCents: Cents }[];
  skipped: { ruleId: string; reason: string }[];
  blocked: { ruleId: string; reasons: string[] }[];
}

export async function runDay(date: string): Promise<DayRun> {
  const run: DayRun = { date, sent: [], skipped: [], blocked: [] };
  const active = activeRuleset();
  if (!active) return run;
  const rs = active.ruleset;
  const plan = buildMonthPlan(rs, monthOf(date), date);
  const queued: QueuedPayout[] = [];
  for (const inst of plan.instances.filter((i) => i.date === date)) {
    const ctx = gateContext() as GateContext;
    if (inst.kind === "extra" && !ctx.events.has(inst.key)) continue; // the event did not happen
    if (ctx.history.some((h) => h.instanceKey === inst.key)) continue; // already sent
    const recipient = rs.recipients.find((r) => r.id === inst.recipientId)!;
    const req: PayoutRequest = { source: "scheduler", date, recipientName: recipient.name, recipientEmail: recipient.email, amountCents: inst.amountCents, ruleId: inst.ruleId };
    const verdict = evaluatePayout(req, ctx);
    const rule = rs.rules.find((r) => r.id === inst.ruleId)!;
    if (verdict.decision === "allow") {
      queued.push(insertPayout(req, verdict, "queued"));
      run.sent.push({ ruleId: inst.ruleId, recipient: recipient.name, amountCents: inst.amountCents });
    } else if (verdict.violations.length && verdict.violations.every((v) => v.code === "skipped" || v.code === "extra_limit")) {
      db().prepare("INSERT INTO skips (date, instance_key, rule_id, rules_hash, verdict) VALUES (?, ?, ?, ?, ?)").run(date, inst.key, inst.ruleId, active.hash, JSON.stringify(verdict));
      run.skipped.push({ ruleId: inst.ruleId, reason: verdict.violations[0].message });
      logActivity(date, "skip", `Skipped ${ruleTitle(rs, rule)} on ${formatDate(date)}: ${verdict.violations[0].message}`);
    } else {
      insertPayout(req, verdict, "blocked");
      run.blocked.push({ ruleId: inst.ruleId, reasons: verdict.violations.map((v) => `${v.ruleTitle}: ${v.message}`) });
      logActivity(date, "blocked", `Gatekeeper refused ${ruleTitle(rs, rule)} on ${formatDate(date)} — ${verdict.violations.map((v) => v.ruleTitle).join(", ")}.`);
    }
  }
  await sendBatch(date, queued);
  return run;
}

export async function advanceClock(days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 62) throw new Error("Jump between 1 and 62 days");
  const from = clock();
  const to = addDays(from, days);
  const runs: DayRun[] = [];
  const last = getMeta("last_processed");
  if (activeRuleset() && last) {
    // Each day's run happens at the end of that day.
    for (const d of eachDay(addDays(last, 1), addDays(to, -1))) {
      runs.push(await runDay(d));
      setMeta("last_processed", d);
    }
  }
  setMeta("clock", to);
  logActivity(to, "clock", `Demo clock moved forward ${days} day${days > 1 ? "s" : ""} to ${formatDate(to, { weekday: true, year: true })}.`);
  return { from, to, runs };
}

export async function retryPayout(id: number) {
  const p = db().prepare("SELECT * FROM payouts WHERE id = ?").get(id) as RawPayout | undefined;
  if (!p || p.status !== "failed" || p.retried_by) throw new Error("Only a failed payout can be retried, once");
  const ctx = gateContext();
  if (!ctx) throw new Error("No active rules");
  const req: PayoutRequest = {
    source: "retry",
    date: p.rule_id ? p.date : clock(),
    recipientName: p.recipient_name,
    recipientEmail: p.receiver,
    amountCents: p.amount_cents,
    ruleId: p.rule_id,
    approvedByPerson: !p.rule_id,
  };
  const verdict = evaluatePayout(req, ctx);
  if (verdict.decision !== "allow") {
    logActivity(clock(), "blocked", `Retry refused by the gatekeeper — ${verdict.violations.map((v) => v.ruleTitle).join(", ")}.`);
    return { verdict, payoutId: null };
  }
  const q = insertPayout(req, verdict, "queued", p.id);
  db().prepare("UPDATE payouts SET retried_by = ? WHERE id = ?").run(q.payoutId, p.id);
  await sendBatch(clock(), [q]);
  return { verdict, payoutId: q.payoutId };
}

// ---------------------------------------------------------------------------
// Uncertain events

export function logEvent(trigger: string, note: string) {
  const date = clock();
  db().prepare("INSERT INTO events (rule_trigger, date, note, source) VALUES (?, ?, ?, 'manual')").run(trigger, date, note);
  logActivity(date, "event", `Logged: ${note}`);
}

// ---------------------------------------------------------------------------
// The untrusted agent

export async function runAgent(input: { messageId?: string; raw?: string }) {
  let raw = input.raw ?? "";
  const messageId = input.messageId ?? null;
  if (messageId) {
    const m = db().prepare("SELECT raw FROM messages WHERE id = ?").get(messageId) as { raw: string } | undefined;
    if (!m) throw new Error("No such message");
    raw = m.raw;
  }
  if (!raw.trim()) throw new Error("Paste a message for the agent to read");
  const result = await readMessage(raw, messageId);
  const today = clock();
  const info = db()
    .prepare("INSERT INTO agent_runs (message_id, input, reply, mode, created_on) VALUES (?, ?, ?, ?, ?)")
    .run(messageId, raw, result.reply, result.source, today);
  const runId = Number(info.lastInsertRowid);
  for (const p of result.proposals) {
    const req: PayoutRequest = { source: "agent", date: today, recipientName: p.payeeName, recipientEmail: p.payeePaypalEmail, amountCents: p.amountCents, ruleId: null };
    const ctx = gateContext();
    const verdict: Verdict = ctx
      ? evaluatePayout(req, ctx)
      : { decision: "block", violations: [{ code: "unverified", severity: "block", ruleId: null, ruleTitle: "Verified rules", message: "No verified rules are active yet." }], passed: [], rulesHash: "none", recipientId: null, instanceKey: null };
    const status = verdict.decision === "allow" ? "allowed" : verdict.decision === "needs_approval" ? "needs_approval" : "blocked";
    const pInfo = db()
      .prepare("INSERT INTO proposals (agent_run_id, payee_name, payee_email, amount_cents, reason, quoted, verdict, status, created_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, p.payeeName, p.payeePaypalEmail, p.amountCents, p.reason, p.quotedRequest, JSON.stringify(verdict), status, today);
    const proposalId = Number(pInfo.lastInsertRowid);
    if (status === "blocked") {
      logActivity(today, "blocked", `Gatekeeper blocked the agent's ${formatMoney(p.amountCents)} payment to ${p.payeeName} — ${verdict.violations.map((v) => v.ruleTitle).join(", ")}.`);
    } else if (status === "allowed") {
      await sendProposal(proposalId, false);
    } else {
      logActivity(today, "approval", `The agent proposed ${formatMoney(p.amountCents)} to ${p.payeeName}; it needs your approval.`);
    }
  }
  return { runId, ai: { source: result.source, model: result.model, note: result.note } };
}

async function sendProposal(proposalId: number, approvedByPerson: boolean) {
  const p = db().prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId) as {
    id: number; payee_name: string; payee_email: string; amount_cents: number; status: string;
  };
  const ctx = gateContext();
  if (!ctx) throw new Error("No active rules");
  const req: PayoutRequest = { source: "agent", date: clock(), recipientName: p.payee_name, recipientEmail: p.payee_email, amountCents: p.amount_cents, ruleId: null, approvedByPerson };
  const verdict = evaluatePayout(req, ctx);
  if (verdict.decision !== "allow") {
    db().prepare("UPDATE proposals SET verdict = ?, status = 'blocked' WHERE id = ?").run(JSON.stringify(verdict), proposalId);
    return verdict;
  }
  const q = insertPayout(req, verdict, "queued");
  db().prepare("UPDATE proposals SET verdict = ?, status = 'sent', payout_id = ? WHERE id = ?").run(JSON.stringify(verdict), q.payoutId, proposalId);
  logActivity(clock(), "oneoff", `Gatekeeper allowed ${formatMoney(p.amount_cents)} to ${p.payee_name}${approvedByPerson ? " after your approval" : ""}.`);
  await sendBatch(clock(), [q]);
  return verdict;
}

export async function decideProposal(id: number, approve: boolean) {
  const p = db().prepare("SELECT status FROM proposals WHERE id = ?").get(id) as { status: string } | undefined;
  if (!p || p.status !== "needs_approval") throw new Error("This proposal is not waiting for approval");
  if (!approve) {
    db().prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(id);
    logActivity(clock(), "approval", "You declined the agent's proposal.");
    return null;
  }
  return sendProposal(id, true);
}

// ---------------------------------------------------------------------------
// Funding the balance through PayPal Checkout

export async function createFundingOrder(amountCents: Cents) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 500000) throw new Error("Top up between $1 and $5,000");
  const adapter = await paypal();
  const order = await adapter.createOrder(amountCents, "Spendproof balance top-up");
  db().prepare("INSERT INTO fundings (order_id, amount_cents, status, mode, date) VALUES (?, ?, ?, ?, ?)").run(order.id, amountCents, order.status, adapter.mode, clock());
  return order;
}

export async function captureFundingOrder(orderId: string) {
  const row = db().prepare("SELECT * FROM fundings WHERE order_id = ?").get(orderId) as { amount_cents: number; status: string } | undefined;
  if (!row) throw new Error("Unknown order");
  if (row.status === "COMPLETED") return { status: "COMPLETED" };
  const adapter = await paypal();
  const captured = await adapter.captureOrder(orderId);
  const amount = captured.amountCents || row.amount_cents;
  db().prepare("UPDATE fundings SET status = ?, payer = ?, amount_cents = ? WHERE order_id = ?").run(captured.status, captured.payer, amount, orderId);
  if (captured.status === "COMPLETED") logActivity(clock(), "fund", `Balance topped up with ${formatMoney(amount)} through PayPal Checkout (order ${orderId}).`);
  return { status: captured.status };
}

export { describeRule, fromDecimalString };
