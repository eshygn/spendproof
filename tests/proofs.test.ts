import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { init } from "z3-solver";
import { DEMO_RULESET, DEMO_START } from "@/domain/demo";
import { proofKey } from "@/domain/proofKey";
import { suggestRepairs, type Repair } from "@/domain/repairs";
import type { Ruleset } from "@/domain/rules";
import { verify, type VerifyReport, type Z3Ctx } from "@/domain/verify";

let Z: Z3Ctx;
beforeAll(async () => {
  const { Context } = await init();
  Z = new Context("main");
});

const dir = path.join(process.cwd(), "fixtures", "proofs");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
const withoutTiming = (r: VerifyReport) => ({ ...r, stats: { ...r.stats, ms: 0 } });

describe("stored proofs", () => {
  it("exist for the demo rules and the repaired demo rules", () => {
    expect(files.sort()).toEqual(["demo-rules-repaired.json", "demo-rules.json"]);
  });

  it.each(files)("%s still matches a live Z3 run (re-record with npm run proofs:record if not)", async (file) => {
    const stored = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { key: string; report: VerifyReport; repairs: Repair[] | null };
    const ruleset: Ruleset = file === "demo-rules.json" ? DEMO_RULESET : stored.repairs === null ? findRepaired() : DEMO_RULESET;
    const input = { ruleset, start: DEMO_START };
    expect(proofKey(input)).toBe(stored.key);
    const live = await verify(Z, input);
    expect(withoutTiming(live)).toEqual(withoutTiming(stored.report));
    if (stored.repairs) expect(await suggestRepairs(Z, { ...input, report: live })).toEqual(stored.repairs);
  });

  it("tells the same counterexample story on repeated runs in one Z3 context", async () => {
    const input = { ruleset: DEMO_RULESET, start: DEMO_START };
    const a = await verify(Z, input);
    const b = await verify(Z, input);
    expect(b.failure?.counterexample.events).toEqual(a.failure?.counterexample.events);
    expect(a.failure?.counterexample.refusedGuaranteed.map((r) => r.date)).toEqual(["2027-01-29"]);
  });

  it("keys on what the proof depends on, not on names or PayPal emails", () => {
    const base = { ruleset: DEMO_RULESET, start: DEMO_START };
    const renamed = { ...base, ruleset: { ...DEMO_RULESET, recipients: DEMO_RULESET.recipients.map((r) => ({ ...r, email: `x${r.email}`, name: "Someone" })) } };
    expect(proofKey(renamed)).toBe(proofKey(base));
    expect(proofKey({ ...base, start: "2026-11-02" })).not.toBe(proofKey(base));
    const changed = { ...base, ruleset: { ...DEMO_RULESET, rules: DEMO_RULESET.rules.map((r) => (r.kind === "cap" ? { ...r, limitCents: 44000 } : r)) } };
    expect(proofKey(changed)).not.toBe(proofKey(base));
    const withHistory = { ...base, history: [{ date: "2026-11-01", ruleId: null, recipientId: "ava", amountCents: 100 }] };
    expect(proofKey(withHistory)).not.toBe(proofKey(base));
  });
});

function findRepaired(): Ruleset {
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "demo-rules.json"), "utf8")) as { repairs: Repair[] };
  const skip = stored.repairs.find((r) => r.kind === "add_skip");
  if (!skip) throw new Error("demo-rules.json has no skip-rule repair");
  return skip.ruleset;
}
