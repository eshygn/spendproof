import "server-only";
import fs from "node:fs";
import path from "node:path";
import { proofKey, type ProofInput } from "@/domain/proofKey";
import type { Repair } from "@/domain/repairs";
import type { Ruleset } from "@/domain/rules";
import type { VerifyReport } from "@/domain/verify";
import { db } from "./db";

/**
 * Stored proofs for slow hosts. Render's free plan has 0.1 CPU, where Z3 can
 * take tens of seconds. With SPENDPROOF_STORED_PROOFS=1 (set only in
 * render.yaml), a verification whose key matches a proof Z3 already produced,
 * either committed under fixtures/proofs or computed earlier by this server,
 * is reused and labelled as such in the UI. Everything else goes to live Z3.
 * Off by default, so local runs and the demo video always show live Z3.
 */

export interface StoredProof {
  key: string;
  provedAt: string;
  source: "fixture" | "cache";
  report: VerifyReport;
  repairs: Repair[] | null;
}

export function storedProofsEnabled(): boolean {
  return process.env.SPENDPROOF_STORED_PROOFS === "1";
}

let fixtures: Map<string, StoredProof> | null = null;

function loadFixtures(): Map<string, StoredProof> {
  if (fixtures) return fixtures;
  fixtures = new Map();
  const dir = path.join(process.cwd(), "fixtures", "proofs");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Omit<StoredProof, "source">;
      fixtures.set(p.key, { ...p, source: "fixture" });
    }
  }
  return fixtures;
}

function ensureTable() {
  db().exec("CREATE TABLE IF NOT EXISTS proof_cache (key TEXT PRIMARY KEY, report TEXT NOT NULL, repairs TEXT, proved_at TEXT NOT NULL)");
}

export function findProof(input: ProofInput): StoredProof | null {
  if (!storedProofsEnabled()) return null;
  const key = proofKey(input);
  ensureTable();
  const row = db().prepare("SELECT report, repairs, proved_at FROM proof_cache WHERE key = ?").get(key) as
    | { report: string; repairs: string | null; proved_at: string }
    | undefined;
  if (row) return { key, provedAt: row.proved_at, source: "cache", report: JSON.parse(row.report), repairs: row.repairs ? JSON.parse(row.repairs) : null };
  return loadFixtures().get(key) ?? null;
}

export function rememberProof(input: ProofInput, report: VerifyReport, repairs: Repair[] | null = null) {
  if (!storedProofsEnabled() || report.verdict === "unknown") return;
  ensureTable();
  db()
    .prepare(
      `INSERT INTO proof_cache (key, report, repairs, proved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET report = excluded.report, repairs = COALESCE(excluded.repairs, proof_cache.repairs)`,
    )
    .run(proofKey(input), JSON.stringify(report), repairs ? JSON.stringify(repairs) : null, new Date().toISOString());
}

/** Stored repairs carry the demo's recipients; re-attach the current ones (repairs only ever change rules). */
export function rebaseRepairs(repairs: Repair[], current: Ruleset): Repair[] {
  return repairs.map((r) => ({ ...r, ruleset: { ...r.ruleset, recipients: current.recipients } }));
}
