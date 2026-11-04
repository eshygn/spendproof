"use client";

import { useState } from "react";
import type { Verdict } from "@/domain/gatekeeper";
import { formatDate } from "@/lib/calendar";
import { formatMoney } from "@/lib/money";
import type { Snapshot } from "@/lib/client";
import type { Run } from "./App";
import { Btn, Icon } from "./ui";

type Message = { id: string; channel: string; sender: string; senderAddress: string; subject: string; receivedOn: string; body: string; raw: string };

/** Show the raw source with anything hidden from a human reader marked. */
function RawSource({ raw }: { raw: string }) {
  const parts = raw.split(/(<span[^>]*>[\s\S]*?<\/span>)/g);
  return (
    <div className="mail-b raw">
      {parts.map((p, i) => (p.startsWith("<span") ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </div>
  );
}

export function InboxPanel({ state, run, busy }: { state: Snapshot; run: Run; busy: string | null }) {
  const messages = state.messages as Message[];
  const [selected, setSelected] = useState<string>(messages[0]?.id ?? "");
  const [showRaw, setShowRaw] = useState(false);
  const [pasted, setPasted] = useState("");
  const msg = messages.find((m) => m.id === selected);
  const runs = state.agentRuns.filter((r) => (selected === "__paste" ? r.message_id === null : r.message_id === selected));

  return (
    <div className="grid-2">
      <section className="stack">
        <div className="card">
          <div className="card-h">
            <Icon name="mail" />
            <h2>Inbox</h2>
            <span className="tiny muted">emails and messages you paste for the agent</span>
          </div>
          <div className="card-b stack" style={{ gap: 10 }}>
            <div className="msgs">
              {messages.map((m) => (
                <button key={m.id} className="msg" aria-pressed={selected === m.id} onClick={() => setSelected(m.id)}>
                  <span className="from">
                    {m.sender}
                    <span className="tiny muted">{formatDate(m.receivedOn)}</span>
                  </span>
                  <span className="subj">{m.subject}</span>
                </button>
              ))}
              <button className="msg" aria-pressed={selected === "__paste"} onClick={() => setSelected("__paste")}>
                <span className="from">Paste your own…</span>
                <span className="subj">Any email or message text</span>
              </button>
            </div>
          </div>
        </div>

        {selected === "__paste" ? (
          <div className="card card-b stack">
            <textarea className="input prompt" placeholder="Paste an email or message…" value={pasted} onChange={(e) => setPasted(e.target.value)} aria-label="Message text" />
            <div>
              <Btn kind="primary" busy={busy === "agent"} disabled={!pasted.trim()} onClick={() => run("agent", { type: "agent", raw: pasted })}>
                <Icon name="bot" /> Ask the agent
              </Btn>
            </div>
          </div>
        ) : msg ? (
          <div className="mail">
            <div className="mail-h">
              <span><b>{msg.sender}</b> <span className="muted">&lt;{msg.senderAddress}&gt;</span></span>
              <span><b>{msg.subject}</b></span>
            </div>
            {showRaw ? <RawSource raw={msg.raw} /> : <div className="mail-b">{msg.body}</div>}
            <div className="row wrap" style={{ padding: "0 14px 14px" }}>
              <Btn kind="primary" busy={busy === "agent"} onClick={() => run("agent", { type: "agent", messageId: msg.id })}>
                <Icon name="bot" /> Ask the agent to handle it
              </Btn>
              {msg.raw !== msg.body ? (
                <Btn size="sm" kind="ghost" onClick={() => setShowRaw((v) => !v)}>
                  <Icon name="eye" /> {showRaw ? "Hide source" : "View source"}
                </Btn>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="stack">
        <div className="card">
          <div className="card-h">
            <Icon name="bot" />
            <h2>Chat agent</h2>
            <span className="pill hold">untrusted · no PayPal credentials</span>
          </div>
          <div className="card-b agent">
            {!state.active ? (
              <div className="callout warn">No verified rules are live yet, so the gatekeeper will block everything the agent proposes.</div>
            ) : null}
            {!runs.length ? (
              <div className="empty">The agent reads the message and may propose payments. It can’t send any: every proposal goes to the gatekeeper.</div>
            ) : (
              runs.map((r) => (
                <div key={r.id} className="stack" style={{ gap: 10 }}>
                  <div className="bubble">
                    <div className="who">
                      <Icon name="bot" size={13} /> Agent {r.mode === "live" ? "· Gemini" : r.mode === "cache" ? "· Gemini (cached)" : "· recorded response"}
                    </div>
                    {r.reply}
                  </div>
                  {r.proposals.map((p) => (
                    <Proposal key={p.id} p={p} run={run} busy={busy} />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Proposal({
  p, run, busy,
}: {
  p: { id: number; payee_name: string; payee_email: string; amount_cents: number; reason: string; quoted: string; status: string; verdict: Verdict };
  run: Run;
  busy: string | null;
}) {
  const v = p.verdict;
  const tone = p.status === "blocked" ? "block" : p.status === "needs_approval" ? "hold" : p.status === "rejected" ? "hold" : "allow";
  const blocks = v.violations.filter((x) => x.severity === "block");
  const holds = v.violations.filter((x) => x.severity === "approval");
  return (
    <div className="proposal">
      <div className="proposal-h">
        <div>
          <div className="upper">Proposed payment</div>
          <div style={{ fontWeight: 600 }}>{p.payee_name}</div>
          <div className="small muted mono">{p.payee_email}</div>
        </div>
        <span className="amt money">{formatMoney(p.amount_cents)}</span>
        <div className="small muted" style={{ gridColumn: "1 / -1", marginTop: 6 }}>“{p.quoted}”</div>
      </div>
      <div className={`gate ${tone}`}>
        <div className="gate-title">
          <Icon name="shield" />
          {p.status === "blocked"
            ? `Gatekeeper blocked it — breaks ${blocks.length} rule${blocks.length === 1 ? "" : "s"}`
            : p.status === "needs_approval"
              ? "Gatekeeper: needs your approval"
              : p.status === "rejected"
                ? "You declined it"
                : "Gatekeeper allowed it — sent to PayPal"}
          <span className="spacer" />
          <span className="hash">{v.rulesHash}</span>
        </div>
        <ul className="viol">
          {[...blocks, ...holds].map((x, i) => (
            <li key={i}>
              <Icon name={x.severity === "block" ? "x" : "hand"} size={15} stroke={2.2} />
              <span><span className="k">{x.ruleTitle}.</span> {x.message}</span>
            </li>
          ))}
          {v.passed.map((x, i) => (
            <li key={`p${i}`} className="pass">
              <Icon name="check" size={15} />
              <span>{x}</span>
            </li>
          ))}
        </ul>
        {p.status === "needs_approval" ? (
          <div className="row" style={{ marginTop: 10 }}>
            <Btn kind="primary" size="sm" busy={busy === `approve${p.id}`} onClick={() => run(`approve${p.id}`, { type: "decide", id: p.id, approve: true })}>Approve &amp; send</Btn>
            <Btn size="sm" busy={busy === `decline${p.id}`} onClick={() => run(`decline${p.id}`, { type: "decide", id: p.id, approve: false })}>Decline</Btn>
          </div>
        ) : null}
      </div>
    </div>
  );
}
