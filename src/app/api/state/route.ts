import { NextResponse } from "next/server";
import { snapshot } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await snapshot(), { headers: { "Cache-Control": "no-store" } });
}
