/**
 * Records the stored proofs used on slow hosts (see src/server/proofs.ts):
 * the demo rules as drafted, and the demo rules after the skip-rule repair.
 * Run with `npm run proofs:record` after any change to the verifier, and
 * bump VERIFIER_VERSION in src/domain/proofKey.ts.
 * tests/proofs.test.ts recomputes every file here with live Z3 and fails if
 * any of them no longer matches.
 */
import fs from "node:fs";
import path from "node:path";
import { init } from "z3-solver";
import { DEMO_RULESET, DEMO_START } from "../src/domain/demo";
import { proofKey } from "../src/domain/proofKey";
import { suggestRepairs } from "../src/domain/repairs";
import { verify } from "../src/domain/verify";

async function main() {
  const { Context } = await init();
  const Z = new Context("main");
  const dir = path.join(process.cwd(), "fixtures", "proofs");
  fs.mkdirSync(dir, { recursive: true });
  const provedAt = new Date().toISOString();

  const input = { ruleset: DEMO_RULESET, start: DEMO_START };
  const report = await verify(Z, input);
  const repairs = await suggestRepairs(Z, { ...input, report });
  write(dir, "demo-rules", { key: proofKey(input), provedAt, report, repairs });

  const skip = repairs.find((r) => r.kind === "add_skip");
  if (!skip) throw new Error("expected a skip-rule repair for the demo rules");
  const repairedInput = { ruleset: skip.ruleset, start: DEMO_START };
  const repairedReport = await verify(Z, repairedInput);
  write(dir, "demo-rules-repaired", { key: proofKey(repairedInput), provedAt, report: repairedReport, repairs: null });
  process.exit(0);
}

function write(dir: string, name: string, data: object) {
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(data, null, 1)}\n`);
  console.log(`wrote fixtures/proofs/${name}.json`);
}

main();
