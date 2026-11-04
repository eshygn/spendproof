"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDate, monthName, monthOf, WEEKDAYS, weekday } from "@/lib/calendar";
import { act, fetchState, type Snapshot } from "@/lib/client";
import { InboxPanel } from "./InboxPanel";
import { PayoutsPanel } from "./PayoutsPanel";
import { ProofPanel } from "./ProofPanel";
import { RulesPanel } from "./RulesPanel";
import { Btn, Icon, Money } from "./ui";

export type Run = (key: string, body: Record<string, unknown>, opts?: { then?: (data: unknown) => void; toast?: string }) => Promise<unknown>;

type Tab = "rules" | "inbox" | "payouts";

export function App({ initial }: { initial: Snapshot }) {
  const [state, setState] = useState<Snapshot>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>(initial.active ? "inbox" : "rules");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchState());
    } catch {
      /* keep the last state */
    }
  }, []);

  const showToast = useCallback((text: string, err = false) => {
    setToast({ text, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), err ? 7000 : 3500);
  }, []);

  const run: Run = useCallback(
    async (key, body, opts) => {
      setBusy(key);
      try {
        const data = await act(body);
        await refresh();
        opts?.then?.(data);
        if (opts?.toast) showToast(opts.toast);
        return data;
      } catch (e) {
        showToast((e as Error).message, true);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refresh, showToast],
  );

  // Poll while PayPal batches are in flight.
  const inFlight = state.payouts.some((p) => ["queued", "pending", "processing"].includes(p.status));
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [inFlight, refresh]);

  const proposalsWaiting = state.agentRuns.flatMap((r) => r.proposals).filter((p) => p.status === "needs_approval").length;
  const failed = state.payouts.filter((p) => p.status === "failed" && !p.retriedBy).length;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" aria-label="Spendproof">
          <span className="brand-mark">
            <svg viewBox="0 0 20 20" fill="none" stroke="#f3efe6" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 10.5 8.5 14.5 15.5 5.5" />
            </svg>
          </span>
          <span className="brand-name">Spendproof</span>
          <span className="brand-tag">rules your payment agent can’t talk its way around</span>
        </div>
        <div className="chips">
          <span className={`chip ${state.modes.paypal.mode === "live" ? "live" : "mock"}`} title={state.modes.paypal.reason}>
            <span className="dot" />
            PayPal <b>{state.modes.paypal.mode === "live" ? "Sandbox · live" : "Mock"}</b>
          </span>
          <span className={`chip ${state.modes.ai.mode === "live" ? "live" : "mock"}`} title={state.modes.ai.reason}>
            <span className="dot" />
            AI <b>{state.modes.ai.mode === "live" ? (state.modes.ai.model ?? "Gemini") : "Recorded"}</b>
            {state.modes.ai.mode !== "live" ? <span className="muted"> · {shortReason(state.modes.ai.reason)}</span> : null}
          </span>
          <span className="chip live" title="Z3 theorem prover (WebAssembly), running on the server">
            <span className="dot" />
            Z3 <b>{state.modes.z3.version}</b> <span className="muted">wasm</span>
          </span>
        </div>
      </header>

      <div className="layout">
        <main className="main">
          <nav className="tabs" role="tablist" aria-label="Sections">
            <button className="tab" role="tab" aria-selected={tab === "rules"} onClick={() => setTab("rules")}>
              <span className="num">1</span> Rules &amp; proof
              {state.draft?.verification?.verdict === "counterexample" ? <span className="badge">clash</span> : null}
            </button>
            <button className="tab" role="tab" aria-selected={tab === "inbox"} onClick={() => setTab("inbox")}>
              <span className="num">2</span> Inbox agent
              {proposalsWaiting ? <span className="badge">{proposalsWaiting}</span> : null}
            </button>
            <button className="tab" role="tab" aria-selected={tab === "payouts"} onClick={() => setTab("payouts")}>
              <span className="num">3</span> Payouts
              {failed ? <span className="badge">{failed} failed</span> : null}
            </button>
          </nav>

          {tab === "rules" ? (
            <div className="grid-2">
              <RulesPanel state={state} run={run} busy={busy} />
              <ProofPanel state={state} run={run} busy={busy} onActivated={() => setTab("inbox")} />
            </div>
          ) : tab === "inbox" ? (
            <InboxPanel state={state} run={run} busy={busy} />
          ) : (
            <PayoutsPanel state={state} run={run} busy={busy} />
          )}
        </main>

        <Rail state={state} run={run} busy={busy} onJump={() => setTab("payouts")} />
      </div>

      {toast ? <div className={`toast ${toast.err ? "err" : ""}`} role="status">{toast.text}</div> : null}
    </div>
  );
}

function Rail({ state, run, busy, onJump }: { state: Snapshot; run: Run; busy: string | null; onJump: () => void }) {
  const month = monthOf(state.clock);
  const active = state.active?.ruleset ?? null;
  const caps = useMemo(() => (active ? active.rules.filter((r) => r.kind === "cap") : []), [active]);
  const sentThisMonth = state.payouts
    .filter((p) => monthOf(p.date) === month && !["failed", "blocked", "returned", "denied"].includes(p.status))
    .reduce((s, p) => s + p.amountCents, 0);
  const overall = caps.find((c) => c.kind === "cap" && c.scope.type === "overall");
  const limit = overall && overall.kind === "cap" ? overall.limitCents : null;

  const jump = (days: number) =>
    run(`jump${days}`, { type: "advance", days }, {
      then: (d) => {
        const data = d as { runs: { sent: unknown[] }[] };
        if (data.runs.some((r) => r.sent.length)) onJump();
      },
    });

  return (
    <aside className="rail">
      <section className="card clock" aria-label="Demo clock">
        <div className="row">
          <span className="upper">Demo clock</span>
          <span className="spacer" />
          <Btn size="sm" kind="ghost" busy={busy === "reset"} onClick={() => run("reset", { type: "reset" }, { toast: "Demo reset to 1 November 2026." })}>
            Reset demo
          </Btn>
        </div>
        <div className="date" style={{ marginTop: 8 }}>{formatDate(state.clock, { year: true })}</div>
        <div className="wd">
          {WEEKDAYS[weekday(state.clock)]} · {state.active ? "rules live, scheduler running" : "no rules live yet"}
        </div>
        <div className="jumps">
          <Btn size="sm" busy={busy === "jump1"} onClick={() => jump(1)}>+1 day</Btn>
          <Btn size="sm" busy={busy === "jump7"} onClick={() => jump(7)}>+1 week</Btn>
          <Btn size="sm" kind="primary" busy={busy === "jump28"} onClick={() => jump(28)}>+4 weeks</Btn>
        </div>
      </section>

      <section className="card card-b" aria-label="Balance">
        <div className="row">
          <span className="upper">Funded balance</span>
          <span className="spacer" />
          <span className="tiny muted">PayPal sender account</span>
        </div>
        <div className="display" style={{ fontSize: 26, fontWeight: 600, marginTop: 4 }}>
          <Money cents={state.balanceCents} />
        </div>
        {limit !== null ? (
          <div style={{ marginTop: 12 }}>
            <div className="row small">
              <span>Sent in {monthName(month)}</span>
              <span className="spacer" />
              <Money cents={sentThisMonth} currency={false} /> <span className="muted">/</span> <Money cents={limit} compact currency={false} />
            </div>
            <div className={`meter ${sentThisMonth > limit * 0.9 ? "hot" : ""}`} style={{ marginTop: 6 }}>
              <i style={{ width: `${Math.min(100, (sentThisMonth / limit) * 100)}%` }} />
            </div>
          </div>
        ) : null}
      </section>

      <section className="card" aria-label="Activity" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        <div className="card-h" style={{ paddingBottom: 10 }}>
          <Icon name="clock" />
          <h2>Activity</h2>
        </div>
        <ul className="feed">
          {state.activity.map((a) => {
            const item = a as { id: number; date: string; kind: string; text: string };
            return (
              <li key={item.id} className={`k-${item.kind}`}>
                <span className="b" />
                <span>
                  <span className="when">{formatDate(item.date)}</span> {item.text}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

function shortReason(reason: string): string {
  if (/No GOOGLE_GENERATIVE_AI_API_KEY/.test(reason)) return "no API key";
  if (/FORCE_MOCK/.test(reason)) return "mock mode";
  if (/429|Rate limit/i.test(reason)) return "rate-limited";
  if (/503|overloaded/i.test(reason)) return "model busy";
  return "offline";
}
