"use client";

import type { Snapshot } from "@/server/snapshot";

export type { Snapshot };
export type Draft = NonNullable<Snapshot["draft"]>;

export class ActionError extends Error {}

export async function act<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ActionError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function fetchState(): Promise<Snapshot> {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load state");
  return res.json();
}
