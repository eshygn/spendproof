"use client";

import type { ReactNode } from "react";
import { formatMoney } from "@/lib/money";

export function Money({ cents, compact, currency = true, className = "" }: { cents: number; compact?: boolean; currency?: boolean; className?: string }) {
  return <span className={`money ${className}`}>{formatMoney(cents, { compact, currency })}</span>;
}

export function Spinner() {
  return <span className="spin" aria-hidden />;
}

export function Btn({
  children, onClick, kind = "", busy, disabled, size = "", title, type = "button",
}: {
  children: ReactNode; onClick?: () => void; kind?: string; busy?: boolean; disabled?: boolean; size?: string; title?: string; type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`btn ${kind} ${size}`} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

const paths: Record<string, ReactNode> = {
  repeat: <path d="M4 7h11l-3-3M16 13H5l3 3" />,
  plus: <path d="M10 4v12M4 10h12" />,
  cap: <path d="M3 14h14M5 14V8m5 6V5m5 9v-4" />,
  skip: <path d="M5 5l7 5-7 5V5zM15 5v10" />,
  users: <path d="M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-4 8a4 4 0 0 1 8 0M14 8a2.5 2.5 0 1 0 0-5M13 12a4 4 0 0 1 4 5" />,
  hand: <path d="M10 3v8M6 7v6a4 4 0 0 0 8 0V9m-4-2V3" />,
  once: <path d="M4 10a6 6 0 1 0 12 0 6 6 0 0 0-12 0zm6-3v3l2 2" />,
  check: <path d="M4 10.5l4 4 8-9" />,
  x: <path d="M5 5l10 10M15 5L5 15" />,
  warn: <path d="M10 3l8 14H2L10 3zm0 6v3m0 3v.01" />,
  shield: <path d="M10 2l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V5l7-3z" />,
  bolt: <path d="M11 2L4 11h5l-1 7 7-9h-5l1-7z" />,
  mail: <path d="M3 5h14v10H3V5zm0 0l7 6 7-6" />,
  bot: <path d="M6 7h8a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3zm4-4v4M7.5 11.5h.01M12.5 11.5h.01" />,
  clock: <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm0-12v4l3 2" />,
  eye: <path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6zm8 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />,
  retry: <path d="M4 10a6 6 0 1 0 2-4.5M4 3v4h4" />,
  arrow: <path d="M4 10h12m-4-4 4 4-4 4" />,
};

export function Icon({ name, size = 16, stroke = 1.8 }: { name: keyof typeof paths | string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name] ?? paths.check}
    </svg>
  );
}

export const kindIcon: Record<string, string> = {
  recurring: "repeat",
  extra: "plus",
  cap: "cap",
  skip: "skip",
  approved_recipients: "users",
  approval: "hand",
  one_off: "once",
};

export const kindLabel: Record<string, string> = {
  recurring: "Recurring",
  extra: "Conditional extra",
  cap: "Spending cap",
  skip: "Skip rule",
  approved_recipients: "Approved recipients",
  approval: "Approval",
  one_off: "One-off",
};

const statusLabels: Record<string, [string, string]> = {
  queued: ["Queued", "accent"],
  pending: ["Pending", "accent"],
  processing: ["Processing", "accent"],
  success: ["Paid", "proof"],
  unclaimed: ["Sent · unclaimed", "proof"],
  onhold: ["On hold", "hold"],
  failed: ["Failed", "breach"],
  returned: ["Returned", "breach"],
  blocked: ["Blocked", "breach"],
  denied: ["Denied", "breach"],
  refunded: ["Refunded", "hold"],
};

export function StatusPill({ status }: { status: string }) {
  const [label, tone] = statusLabels[status] ?? [status, ""];
  return <span className={`pill ${tone}`}>{label}</span>;
}
