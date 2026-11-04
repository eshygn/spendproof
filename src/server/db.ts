import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DEMO_CONTACTS, DEMO_EVENTS, DEMO_MESSAGES, DEMO_START } from "@/domain/demo";

/**
 * SQLite through better-sqlite3. One file, created and seeded on boot.
 * "Reset demo" drops every row and seeds the scenario again.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rulesets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  source TEXT NOT NULL,          -- ai | recorded | repair | manual
  prompt TEXT,
  note TEXT,
  changed TEXT,
  unsupported TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,          -- draft | active | archived
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ruleset_id INTEGER NOT NULL,
  hash TEXT NOT NULL,
  start TEXT NOT NULL,
  end_date TEXT NOT NULL,
  verdict TEXT NOT NULL,
  report TEXT NOT NULL,
  repairs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_trigger TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, sender TEXT NOT NULL, sender_address TEXT NOT NULL,
  subject TEXT NOT NULL, received_on TEXT NOT NULL, body TEXT NOT NULL, raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  input TEXT NOT NULL,
  reply TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id INTEGER NOT NULL,
  payee_name TEXT NOT NULL,
  payee_email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  quoted TEXT NOT NULL,
  verdict TEXT NOT NULL,
  status TEXT NOT NULL,          -- blocked | needs_approval | sent | rejected
  payout_id INTEGER,
  created_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_batch_id TEXT NOT NULL UNIQUE,
  paypal_batch_id TEXT,
  date TEXT NOT NULL,
  status TEXT NOT NULL,          -- CREATING | PENDING | PROCESSING | SUCCESS | DENIED | FAILED | ERROR
  mode TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  error TEXT,
  polls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  rule_id TEXT,
  instance_key TEXT,
  recipient_id TEXT,
  recipient_name TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,          -- scheduler | agent | retry
  rules_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | pending | success | unclaimed | onhold | failed | returned | ...
  batch_id INTEGER,
  sender_item_id TEXT NOT NULL,
  payout_item_id TEXT,
  transaction_id TEXT,
  error TEXT,
  retry_of INTEGER,
  retried_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rules_hash TEXT NOT NULL,
  verdict TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fundings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  payer TEXT,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

const TABLES = [
  "meta", "contacts", "rulesets", "verifications", "events", "messages", "agent_runs",
  "proposals", "batches", "payouts", "skips", "fundings", "activity",
];

/** The seeded balance: last month's top-up, so the first month's payouts are funded. */
export const SEED_BALANCE_CENTS = 40000;

declare global {
  var __spendproofDb: Database.Database | undefined;
}

function seed(db: Database.Database) {
  const tx = db.transaction(() => {
    for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM sqlite_sequence").run();
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run("clock", DEMO_START);
    meta.run("last_processed", "");
    meta.run("fail_next_batch", "1");
    meta.run("seeded_at", new Date().toISOString());
    const c = db.prepare("INSERT INTO contacts (id, name, email, role) VALUES (?, ?, ?, ?)");
    for (const x of DEMO_CONTACTS) c.run(x.id, x.name, x.email, x.role);
    const e = db.prepare("INSERT INTO events (rule_trigger, date, note, source) VALUES (?, ?, ?, 'seed')");
    for (const x of DEMO_EVENTS) e.run(x.ruleTrigger, x.date, x.note);
    const m = db.prepare(
      "INSERT INTO messages (id, channel, sender, sender_address, subject, received_on, body, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const x of DEMO_MESSAGES) m.run(x.id, x.channel, x.from, x.fromAddress, x.subject, x.receivedOn, x.body, x.raw);
    db.prepare(
      "INSERT INTO fundings (order_id, amount_cents, status, mode, payer, date) VALUES ('SEED-OCT-TOPUP', ?, 'COMPLETED', 'seed', 'October top-up', '2026-10-28')",
    ).run(SEED_BALANCE_CENTS);
    db.prepare("INSERT INTO activity (date, kind, text) VALUES (?, 'demo', ?)").run(
      DEMO_START,
      "Demo scenario loaded. Balance funded with $400.00 USD from October.",
    );
  });
  tx();
}

export function db(): Database.Database {
  if (globalThis.__spendproofDb) return globalThis.__spendproofDb;
  const file = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "spendproof.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  const seeded = conn.prepare("SELECT value FROM meta WHERE key = 'clock'").get();
  if (!seeded) seed(conn);
  globalThis.__spendproofDb = conn;
  return conn;
}

export function resetDemo() {
  seed(db());
}

export function getMeta(key: string): string | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string) {
  db().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function logActivity(date: string, kind: string, text: string, data?: unknown) {
  db()
    .prepare("INSERT INTO activity (date, kind, text, data) VALUES (?, ?, ?, ?)")
    .run(date, kind, text, data === undefined ? null : JSON.stringify(data));
}
