"use client";

import { useEffect, useRef } from "react";
import { ruleTitle } from "@/domain/english";
import type { Repair } from "@/domain/repairs";
import type { Ruleset } from "@/domain/rules";
import type { VerifyReport } from "@/domain/verify";
import { dayNumber, formatDate, monthName } from "@/lib/calendar";
import { formatMoney } from "@/lib/money";
import type { Snapshot } from "@/lib/client";
import type { Run } from "./App";
import { Btn, Icon, Spinner } from "./ui";

export function ProofPanel({ state, run, busy, onActivated }: { state: Snapshot; run: Run; busy: string | null; onActivated: () => void }) {
  const shown = state.draft ?? state.active;
  const ver = shown?.verification ?? null;
  const requested = useRef<number | null>(null);

  // Repairs are searched in the background as soon as a counterexample appears.
  useEffect(() => {
    if (shown && ver?.verdict === "counterexample" && !ver.repairs && requested.current !== ver.id && busy !== "verify") {
      requested.current = ver.id;
      run("repairs", { type: "repairs", id: shown.id });
    }
  }, [shown, ver, run, busy]);

  if (!shown) return <Explainer />;

  if (!shown.confirmed) {
    return (
      <section className="card">
        <div className="card-h"><Icon name="shield" /><h2>Proof</h2></div>
        <div className="card-b"><div className="callout">Confirm the rules on the left. Z3 checks the rules you confirm — nothing else.</div></div>
      </section>
    );
  }

  if (!ver) {
    return (
      <section className="card">
        <div className="card-h"><Icon name="shield" /><h2>Proof</h2></div>
        <div className="card-b stack">
          <p style={{ margin: 0, fontSize: 14 }}>
            Z3 will check every calendar month from <b>{formatDate(state.horizonStart, { year: true })}</b> for 12 months. Each day on which an
            uncertain event could happen (like a big shop) is a free Boolean, so it covers every possible sequence of events.
          </p>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>No spending cap can ever be exceeded.</li>
            <li>No guaranteed payment is ever skipped, even with the gatekeeper enforcing the caps.</li>
          </ul>
          <div>
            <Btn kind="primary" size="lg" busy={busy === "verify"} onClick={() => run("verify", { type: "verify", id: shown.id })}>
              <Icon name="shield" /> Verify with Z3
            </Btn>
          </div>
        </div>
      </section>
    );
  }

  const report = ver.report;
  const rs = shown.ruleset;
  return (
    <section className="stack">
      <div className="card">
        <div className="card-h">
          <Icon name="shield" />
          <h2>Proof</h2>
          <span className="hash">{ver.hash}</span>
          <div className="right">
            {shown.status === "draft" ? (
              <Btn size="sm" kind="ghost" busy={busy === "verify"} onClick={() => run("verify", { type: "verify", id: shown.id })}>Re-run</Btn>
            ) : null}
          </div>
        </div>
        <div className="card-b stack">
          {report.verdict === "counterexample" && report.failure ? (
            <Counterexample report={report} rs={rs} clock={state.clock} />
          ) : report.verdict === "verified" ? (
            <Verified report={report} rs={rs} />
          ) : (
            <div className="callout bad">Z3 could not decide within its time limit, so these rules are not verified and cannot go live.</div>
          )}
          <MonthChart report={report} />
          <div className="stats">
            <span><b>{report.stats.checks}</b> Z3 checks</span>
            <span><b>{report.stats.booleans}</b> free Booleans</span>
            <span><b>{report.horizon.months}</b> months, <b>{report.stats.shapes}</b> distinct shapes</span>
            <span><b>{(report.stats.ms / 1000).toFixed(1)}s</b></span>
          </div>
        </div>
      </div>

      {report.verdict === "counterexample" ? (
        <Repairs repairs={ver.repairs} busy={busy} onApply={(id) => run("applyRepair", { type: "applyRepair", id: shown.id, repairId: id }, { toast: "Repair applied — verifying again with Z3." })} />
      ) : null}

      {report.verdict === "verified" && shown.status === "draft" ? (
        <div className="card card-b row wrap">
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>Ready to go live.</b>
            <div className="small muted">A deterministic scheduler pays these rules through PayPal Payouts. The gatekeeper re-checks every payout first.</div>
          </div>
          <Btn kind="proof" size="lg" busy={busy === "activate"} onClick={() => run("activate", { type: "activate", id: shown.id }, { then: onActivated, toast: `Rules ${shown.hash} are live.` })}>
            <Icon name="bolt" /> Activate rules
          </Btn>
        </div>
      ) : null}
    </section>
  );
}

function Explainer() {
  return (
    <section className="card">
      <div className="card-h"><Icon name="shield" /><h2>What Spendproof proves</h2></div>
      <div className="card-b stack">
        <p style={{ margin: 0, fontSize: 14 }}>
          Plain-English spending rules hide edge cases — like a month with five Fridays. Spendproof turns your rules into data, then asks the
          Z3 theorem prover whether <i>any</i> possible sequence of events in the next 12 months breaks them.
        </p>
        <div className="callout">
          <b>sat</b> means a counterexample: you see the exact dates, payments and totals, and the rules that collide.
          <br />
          <b>unsat</b> means proved: for every possible sequence of events in the horizon, and nothing beyond it.
        </div>
      </div>
    </section>
  );
}

function Counterexample({ report, rs, clock }: { report: VerifyReport; rs: Ruleset; clock: string }) {
  const f = report.failure!;
  const cx = f.counterexample;
  const title = (id: string) => {
    const r = rs.rules.find((x) => x.id === id);
    return r ? ruleTitle(rs, r) : id;
  };
  const name = (rid: string) => rs.recipients.find((r) => r.id === rid)?.name.split(" ")[0] ?? rid;
  const firstOver = cx.steps.findIndex((s) => s.runningCents > cx.limitCents);
  const refused = cx.refusedGuaranteed[0];
  const daysEarly = refused ? dayNumber(refused.date) - dayNumber(clock) : null;
  return (
    <>
      <div className="verdict breach">
        <span className="glyph"><Icon name="x" size={22} stroke={2.4} /></span>
        <span className="big">Counterexample: {monthName(f.month)}</span>
        <span className="sub">
          {cx.property.kind === "cap"
            ? <>The month can reach <b className="money">{formatMoney(cx.totalCents)}</b>, over the <b>{title(cx.capId)}</b>.</>
            : <>A guaranteed payment would be refused on {formatDate(cx.property.date, { weekday: true })}.</>}
        </span>
      </div>

      <div className="cx" role="table" aria-label={`Counterexample for ${monthName(f.month)}`}>
        <div className="cx-row head" role="row"><span>Date</span><span>Payment</span><span className="r">Amount</span><span className="r">Month total</span></div>
        {cx.steps.map((s, i) => (
          <div key={s.key} role="row" className={`cx-row ${s.kind === "extra" ? "event" : ""} ${i === firstOver || i === cx.steps.length - 1 && s.runningCents > cx.limitCents ? "over" : ""}`}>
            <span className="mono small">{formatDate(s.date, { weekday: true })}</span>
            <span className={s.outcome !== "paid" ? "skipped" : ""}>
              {s.kind === "extra" ? <><span className="pill hold">event</span> {name(s.recipientId)}: “{rs.rules.find((r) => r.id === s.ruleId && r.kind === "extra")?.kind === "extra" ? (rs.rules.find((r) => r.id === s.ruleId) as { trigger: string }).trigger : "event"}”</> : title(s.ruleId)}
            </span>
            <span className="r money small">{formatMoney(s.amountCents, { currency: false })}</span>
            <span className="r money small run">{formatMoney(s.runningCents, { currency: false })}</span>
          </div>
        ))}
      </div>

      {refused ? (
        <div className="callout bad">
          With the gatekeeper enforcing the cap, <b>{title(refused.ruleId)}</b> on <b>{formatDate(refused.date, { weekday: true, year: true })}</b> would be refused.
          A database check finds that on the day itself; Z3 found it today, <b>{daysEarly} days</b> early.
        </div>
      ) : null}

      <div>
        <div className="upper" style={{ marginBottom: 6 }}>Unsat core — the rules that collide</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {f.core.map((id) => <span key={id} className="pill breach">{title(id)}</span>)}
        </div>
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          Under these events the {f.core.length} rules can’t all hold. The core is minimal: drop any one and the clash disappears.
        </p>
      </div>
      <div className="row tiny muted"><Icon name="check" size={13} /> Replayed in the TypeScript simulator before being shown: confirmed.</div>
    </>
  );
}

function Verified({ report, rs }: { report: VerifyReport; rs: Ruleset }) {
  const title = (id: string) => {
    const r = rs.rules.find((x) => x.id === id);
    return r ? ruleTitle(rs, r) : id;
  };
  return (
    <>
      <div className="verdict proof">
        <span className="glyph"><Icon name="check" size={22} stroke={2.4} /></span>
        <span className="big">Verified for all {report.horizon.months} months</span>
        <span className="sub">Z3 returned unsat for every property in every month.</span>
      </div>
      <div className="props">
        {report.properties.map((p) => (
          <div key={p.id} className="prop">
            <span className={p.status === "proved" ? "ok" : "no"}><Icon name={p.status === "proved" ? "check" : "x"} size={14} stroke={2.4} /></span>
            <span>
              {p.kind === "cap" ? <>{title(p.ruleId)} is never exceeded</> : <>{title(p.ruleId).replace(" (guaranteed)", "")} is never skipped</>}
            </span>
            <span className={`pill ${p.status === "proved" ? "proof" : "breach"}`}>{p.status === "proved" ? "proved" : p.status}</span>
          </div>
        ))}
      </div>
      <p className="claim">
        Proved for every possible sequence of events from {formatDate(report.horizon.start, { year: true })} to {formatDate(report.horizon.end, { year: true })},
        for these rules exactly as confirmed. Nothing beyond these rules or this horizon is claimed.
      </p>
    </>
  );
}

function MonthChart({ report }: { report: VerifyReport }) {
  const capId = report.failure?.counterexample.capId ?? report.months[0]?.caps[0]?.capId;
  if (!capId) return null;
  const rows = report.months.map((m) => ({ m, c: m.caps.find((c) => c.capId === capId)! }));
  const limit = rows[0]?.c.limitCents ?? 0;
  const max = Math.max(limit, ...rows.map((r) => r.c.worstCaseCents)) * 1.08;
  const W = 720, H = 170, top = 22, bottom = 22, plot = H - top - bottom;
  const slot = W / rows.length;
  const y = (cents: number) => top + plot - (cents / max) * plot;
  return (
    <div>
      <div className="row">
        <span className="upper">Worst case each month · Z3 Optimize</span>
        <span className="spacer" />
        <span className="tiny muted">dashed line: {formatMoney(limit, { compact: true, currency: false })} cap</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Worst-case total per month against the cap" style={{ display: "block", marginTop: 6 }}>
        {rows.map(({ m, c }, i) => {
          const broken = c.status === "broken";
          const x = i * slot + slot * 0.18;
          const w = slot * 0.64;
          const focus = report.failure?.month === m.month;
          return (
            <g key={m.month}>
              <title>{`${m.label}: worst case ${formatMoney(c.worstCaseCents)}${m.sameShapeAs ? " (proof shared with a month of the same shape)" : ""}`}</title>
              <rect x={x} y={y(c.worstCaseCents)} width={w} height={Math.max(2, top + plot - y(c.worstCaseCents))} rx={5}
                style={{ fill: broken ? "var(--breach-2)" : "color-mix(in srgb, var(--proof) 72%, var(--card))", transition: "all .5s" }} />
              <text x={x + w / 2} y={y(c.worstCaseCents) - 6} textAnchor="middle" className="mono"
                style={{ fontSize: 11, fill: broken ? "var(--breach)" : "var(--ink-2)", fontWeight: broken ? 700 : 400 }}>
                {formatMoney(c.worstCaseCents, { compact: true, currency: false })}
              </text>
              <text x={x + w / 2} y={H - 6} textAnchor="middle" style={{ fontSize: 11, fill: focus ? "var(--ink)" : "var(--ink-3)", fontWeight: focus ? 700 : 400 }}>
                {monthName(m.month, true)}
              </text>
            </g>
          );
        })}
        <line x1={0} x2={W} y1={y(limit)} y2={y(limit)} strokeDasharray="6 5" strokeWidth={1.6} style={{ stroke: "var(--ink)", opacity: 0.6 }} />
      </svg>
    </div>
  );
}

function Repairs({ repairs, busy, onApply }: { repairs: Repair[] | null; busy: string | null; onApply: (id: string) => void }) {
  return (
    <div className="card">
      <div className="card-h">
        <Icon name="retry" />
        <h2>Repairs</h2>
        <span className="tiny muted">each one already re-checked by Z3</span>
      </div>
      <div className="card-b">
        {!repairs ? (
          <div className="row muted small"><Spinner /> Searching: structural fixes first, then the largest safe amounts by binary search…</div>
        ) : !repairs.length ? (
          <div className="callout">No automatic repair found. Edit the rules and verify again.</div>
        ) : (
          <div className="repairs">
            {repairs.map((r, i) => (
              <div key={r.id} className={`repair ${i === 0 && r.kind === "add_skip" ? "top" : ""}`}>
                <div className="t">
                  {r.title}
                  {r.fromCents !== undefined && r.toCents !== undefined ? (
                    <span className="money small muted">
                      {formatMoney(r.fromCents, { currency: false })} → <b style={{ color: "var(--ink)" }}>{formatMoney(r.toCents, { currency: false })}</b>
                    </span>
                  ) : null}
                </div>
                <Btn size="sm" kind={i === 0 ? "primary" : ""} busy={busy === "applyRepair"} onClick={() => onApply(r.id)}>Apply</Btn>
                <div className="x">“{r.text}”</div>
                <div className="tiny muted" style={{ gridColumn: "1 / -1" }}>
                  {r.kind === "add_skip" ? "Holds in every month" : "Found by binary search"} · {r.checks} Z3 checks
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

