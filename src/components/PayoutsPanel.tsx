"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { ruleTitle } from "@/domain/english";
import { buildMonthPlan } from "@/domain/plan";
import type { ExtraRuleT } from "@/domain/rules";
import { addMonths, formatDate, monthOf } from "@/lib/calendar";
import { formatMoney } from "@/lib/money";
import type { Snapshot } from "@/lib/client";
import type { Run } from "./App";
import { Btn, Icon, StatusPill } from "./ui";

const FundButton = dynamic(() => import("./FundButton"), {
  ssr: false,
  loading: () => <div className="btn lg" style={{ width: "100%" }}>Loading PayPal…</div>,
});

export function PayoutsPanel({ state, run, busy }: { state: Snapshot; run: Run; busy: string | null }) {
  const rs = state.active?.ruleset ?? null;
  const [topUp, setTopUp] = useState(40000);
  const title = (id: string | null) => {
    if (!id || !rs) return "One-off (agent)";
    const r = rs.rules.find((x) => x.id === id);
    return r ? ruleTitle(rs, r) : id;
  };
  const batches = new Map(state.batches.map((b) => [b.id, b]));
  const extras = rs ? rs.rules.filter((r): r is ExtraRuleT => r.kind === "extra") : [];

  const upcoming = useMemo(() => {
    if (!rs) return [];
    const month = monthOf(state.clock);
    const plans = [buildMonthPlan(rs, month, state.clock), buildMonthPlan(rs, addMonths(month, 1))];
    return plans.flatMap((p) => p.instances).filter((i) => i.kind !== "extra").slice(0, 8);
  }, [rs, state.clock]);

  const payouts = [...state.payouts].reverse();

  return (
    <div className="stack">
      <div className="card">
        <div className="card-h">
          <h2>Payouts</h2>
          <span className="tiny muted">Sent through PayPal Payouts by the scheduler, never by the AI. Each row records the rules version that allowed it.</span>
          <div className="right">
            <Btn size="sm" kind="ghost" busy={busy === "poll"} onClick={() => run("poll", { type: "poll" })}>Refresh status</Btn>
          </div>
        </div>
        <div className="card-b" style={{ overflowX: "auto" }}>
          {!payouts.length ? (
            <div className="empty">
              No payouts yet. {state.active ? "Move the demo clock forward to let the scheduler run." : "Activate verified rules first."}
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Payee</th>
                  <th className="hide-sm">Rule</th>
                  <th className="r">Amount</th>
                  <th>Status</th>
                  <th className="hide-sm">Record</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => {
                  const b = p.batchId ? batches.get(p.batchId) : null;
                  const err = p.error as { name?: string; message?: string } | { name?: string }[] | null;
                  const errName = Array.isArray(err) ? err[0]?.name : err?.name;
                  return (
                    <tr key={p.id}>
                      <td className="mono small nw">{formatDate(p.date, { weekday: true })}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.recipientName}</div>
                        <div className="tiny muted mono">{p.receiver}</div>
                      </td>
                      <td className="hide-sm small" style={{ minWidth: 150 }}>
                        {title(p.ruleId)}
                        {p.retryOf ? <span className="tiny muted"> · retry</span> : null}
                      </td>
                      <td className="r money nw">{formatMoney(p.amountCents)}</td>
                      <td>
                        <StatusPill status={p.status} />
                        {errName && p.status === "unclaimed" ? (
                          <div className="tiny muted" style={{ marginTop: 3 }} title={errName}>awaiting claim · no sandbox account</div>
                        ) : errName ? (
                          <div className="tiny" style={{ color: "var(--breach)", marginTop: 3 }}>{errName}</div>
                        ) : null}
                        {p.status === "blocked" ? <div className="tiny" style={{ color: "var(--breach)", marginTop: 3 }}>{p.verdict.violations.map((v) => v.ruleTitle).join(", ")}</div> : null}
                      </td>
                      <td className="hide-sm tiny mono muted nw" title={[b?.sender_batch_id, p.payoutItemId && `item ${p.payoutItemId}`, p.transactionId && `txn ${p.transactionId}`].filter(Boolean).join(" · ")}>
                        <div title="Rules version that allowed this payout">{p.rulesHash}</div>
                        <div>{b?.paypal_batch_id ? <>PayPal {b.paypal_batch_id}</> : b ? <>not created</> : <>not sent</>}</div>
                      </td>
                      <td className="r">
                        {p.status === "failed" && !p.retriedBy ? (
                          <Btn size="sm" kind="danger" busy={busy === `retry${p.id}`} onClick={() => run(`retry${p.id}`, { type: "retry", id: p.id }, { toast: "Gatekeeper re-checked it; sent again to PayPal." })}>
                            <Icon name="retry" size={13} /> Retry
                          </Btn>
                        ) : p.retriedBy ? <span className="tiny muted">retried</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-h">
            <Icon name="clock" />
            <h2>Coming up</h2>
            <span className="tiny muted">scheduled by the verified rules</span>
          </div>
          <div className="card-b stack" style={{ gap: 10 }}>
            {upcoming.length ? (
              <div className="schedule">
                {upcoming.map((i) => (
                  <div key={i.key} className="sday">
                    <div className="d">{formatDate(i.date, { weekday: true })}</div>
                    <div className="muted">{rs?.recipients.find((r) => r.id === i.recipientId)?.name.split(" ")[0]}</div>
                    <div className="money">{formatMoney(i.amountCents, { compact: true, currency: false })}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">Nothing scheduled. No rules are live yet.</div>
            )}
            {extras.map((x) => (
              <div key={x.id} className="row wrap">
                <span className="small">Uncertain event: <b>{x.trigger}</b></span>
                <span className="spacer" />
                <Btn size="sm" busy={busy === `event${x.id}`} onClick={() => run(`event${x.id}`, { type: "event", trigger: x.id, note: `${x.trigger} (reported ${formatDate(state.clock)})` }, { toast: "Event logged. The scheduler pays it tonight if the rules allow." })}>
                  Log it today
                </Btn>
              </div>
            ))}
            <div className="tiny muted">
              Reported events:{" "}
              {(state.events as { id: number; date: string; note: string }[]).map((e) => formatDate(e.date)).join(", ") || "none"}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Top up the balance</h2>
            <span className="tiny muted">PayPal Checkout</span>
          </div>
          <div className="card-b stack" style={{ gap: 10 }}>
            <div className="row">
              {[10000, 40000, 80000].map((c) => (
                <button key={c} className={`btn sm ${topUp === c ? "primary" : ""}`} onClick={() => setTopUp(c)}>{formatMoney(c, { compact: true, currency: false })}</button>
              ))}
              <span className="spacer" />
              <span className="small muted">USD</span>
            </div>
            <FundButton
              clientId={state.paypalClientId}
              amountCents={topUp}
              onDone={() => run("poll", { type: "poll" }, { toast: `Balance topped up with ${formatMoney(topUp)}.` })}
              onError={(m) => run("poll", { type: "poll" }, { toast: `PayPal: ${m}` })}
            />
            <div className="tiny muted">You pay here; Spendproof pays out from this balance. The gatekeeper refuses any payout the balance can’t cover.</div>
            <hr className="sep" />
            <label className="switch">
              <input type="checkbox" checked={state.failNextBatch} onChange={(e) => run("failNext", { type: "failNext", on: e.target.checked })} />
              Demo: make PayPal refuse the next scheduled batch (sandbox negative test, INSUFFICIENT_FUNDS)
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
