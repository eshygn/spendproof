import { NextResponse } from "next/server";
import { z } from "zod";
import { RulesetError } from "@/domain/rules";
import { AiUnavailableError } from "@/server/adapters/ai";
import { resetDemo, setMeta } from "@/server/db";
import {
  activate,
  advanceClock,
  applyRepair,
  authorFromText,
  captureFundingOrder,
  confirmDraft,
  createFundingOrder,
  decideProposal,
  logEvent,
  pollPayouts,
  repairsFor,
  retryPayout,
  runAgent,
  saveManualDraft,
  verifyRuleset,
} from "@/server/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One endpoint for every user action; each action is a validated, typed command. */
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("author"), text: z.string().min(3).max(2000) }),
  z.object({ type: z.literal("saveJson"), json: z.unknown() }),
  z.object({ type: z.literal("confirm"), id: z.number().int() }),
  z.object({ type: z.literal("verify"), id: z.number().int() }),
  z.object({ type: z.literal("repairs"), id: z.number().int() }),
  z.object({ type: z.literal("applyRepair"), id: z.number().int(), repairId: z.string() }),
  z.object({ type: z.literal("activate"), id: z.number().int() }),
  z.object({ type: z.literal("agent"), messageId: z.string().optional(), raw: z.string().max(8000).optional() }),
  z.object({ type: z.literal("decide"), id: z.number().int(), approve: z.boolean() }),
  z.object({ type: z.literal("advance"), days: z.number().int() }),
  z.object({ type: z.literal("retry"), id: z.number().int() }),
  z.object({ type: z.literal("poll") }),
  z.object({ type: z.literal("event"), trigger: z.string().min(1).max(60), note: z.string().max(200) }),
  z.object({ type: z.literal("failNext"), on: z.boolean() }),
  z.object({ type: z.literal("fundCreate"), amountCents: z.number().int() }),
  z.object({ type: z.literal("fundCapture"), orderId: z.string().min(1) }),
  z.object({ type: z.literal("reset") }),
]);

export async function POST(req: Request) {
  const parsed = Action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  const a = parsed.data;
  try {
    switch (a.type) {
      case "author":
        return NextResponse.json(await authorFromText(a.text));
      case "saveJson":
        return NextResponse.json({ draft: saveManualDraft(a.json) });
      case "confirm":
        return NextResponse.json({ draft: confirmDraft(a.id) });
      case "verify":
        return NextResponse.json({ verification: await verifyRuleset(a.id) });
      case "repairs":
        return NextResponse.json({ repairs: await repairsFor(a.id) });
      case "applyRepair":
        return NextResponse.json(await applyRepair(a.id, a.repairId));
      case "activate":
        return NextResponse.json({ active: activate(a.id) });
      case "agent":
        return NextResponse.json(await runAgent(a));
      case "decide":
        return NextResponse.json({ verdict: await decideProposal(a.id, a.approve) });
      case "advance":
        return NextResponse.json(await advanceClock(a.days));
      case "retry":
        return NextResponse.json(await retryPayout(a.id));
      case "poll":
        await pollPayouts(true);
        return NextResponse.json({ ok: true });
      case "event":
        logEvent(a.trigger, a.note);
        return NextResponse.json({ ok: true });
      case "failNext":
        setMeta("fail_next_batch", a.on ? "1" : "0");
        return NextResponse.json({ ok: true });
      case "fundCreate":
        return NextResponse.json(await createFundingOrder(a.amountCents));
      case "fundCapture":
        return NextResponse.json(await captureFundingOrder(a.orderId));
      case "reset":
        resetDemo();
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    const message =
      e instanceof RulesetError
        ? `Those rules don't validate: ${e.issues.map((i) => i.message).join("; ")}`
        : e instanceof AiUnavailableError
          ? e.message
          : (e as Error).message;
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
