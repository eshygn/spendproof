import "server-only";
import { init } from "z3-solver";
import type { Z3Ctx } from "@/domain/verify";

/**
 * Z3 runs on the server only (Node runtime; listed in serverExternalPackages
 * so Next.js never bundles it). It is initialised once per process, warmed up
 * with a tiny query, and reused. z3-solver is not thread-safe, so every job
 * runs through one queue.
 */

interface Z3Handle {
  ctx: Z3Ctx;
  version: string;
}

declare global {
  var __spendproofZ3: Promise<Z3Handle> | undefined;
  var __spendproofZ3Queue: Promise<unknown> | undefined;
}

async function boot(): Promise<Z3Handle> {
  const api = await init();
  const ctx = new api.Context("main") as Z3Ctx;
  // Warm-up: the first check pays for thread start-up.
  const s = new ctx.Solver();
  const x = ctx.Int.const("warm");
  s.add(x.gt(0), x.lt(2));
  await s.check();
  const version = typeof api.Z3.get_full_version === "function" ? api.Z3.get_full_version() : "z3";
  return { ctx, version };
}

export function z3(): Promise<Z3Handle> {
  globalThis.__spendproofZ3 ??= boot();
  return globalThis.__spendproofZ3;
}

/** Run a Z3 job exclusively. */
export async function withZ3<T>(job: (ctx: Z3Ctx) => Promise<T>): Promise<T> {
  const handle = await z3();
  const prev = globalThis.__spendproofZ3Queue ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => job(handle.ctx));
  globalThis.__spendproofZ3Queue = run;
  return run;
}
