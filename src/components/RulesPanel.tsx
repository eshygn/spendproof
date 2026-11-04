"use client";

import { useState } from "react";
import { DEMO_PROMPT } from "@/domain/demo";
import type { Snapshot } from "@/lib/client";
import type { Run } from "./App";
import { Btn, Icon, kindLabel } from "./ui";

export function RulesPanel({ state, run, busy }: { state: Snapshot; run: Run; busy: string | null }) {
  const shown = state.draft ?? state.active;
  const [text, setText] = useState(shown?.prompt ?? DEMO_PROMPT);
  const [composingState, setComposing] = useState(!shown);
  const composing = composingState || !shown;
  const [editJson, setEditJson] = useState(false);
  const [json, setJson] = useState("");

  const core = new Set(shown?.verification?.report.failure?.core ?? []);
  const changed = new Set(shown?.changed ?? []);
  const isDraft = shown?.status === "draft";

  return (
    <section className="stack">
      <div className="card">
        <div className="card-h">
          <Icon name="bot" />
          <h2>Write your rules</h2>
          <div className="right">
            {!composing && shown ? (
              <Btn size="sm" onClick={() => setComposing(true)}>Rewrite</Btn>
            ) : null}
          </div>
        </div>
        <div className="card-b">
          {composing ? (
            <>
              <textarea
                className="input prompt"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="Your spending rules in plain English"
              />
              <div className="row wrap" style={{ marginTop: 10 }}>
                <Btn
                  kind="primary"
                  busy={busy === "author"}
                  onClick={() =>
                    run("author", { type: "author", text }, { then: () => setComposing(false) })
                  }
                >
                  <Icon name="bolt" /> Turn into rules
                </Btn>
                {text !== DEMO_PROMPT ? (
                  <Btn size="sm" kind="ghost" onClick={() => setText(DEMO_PROMPT)}>Use the sample</Btn>
                ) : null}
                <span className="spacer" />
                <span className="hero-note">Gemini fills a strict tool schema. It never writes the rules text you confirm.</span>
              </div>
            </>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>“{shown?.prompt ?? "Rules edited directly"}”</p>
          )}
        </div>
      </div>

      {shown ? (
        <div className="card">
          <div className="card-h">
            <Icon name="shield" />
            <h2>{isDraft ? "Read these back" : "Live rules"}</h2>
            <span className="hash" title="Rules version: hash of the rules JSON">{shown.hash}</span>
            <div className="right">
              <span className="tiny muted">
                {shown.source === "ai" ? "Drafted by Gemini" : shown.source === "recorded" ? "Recorded AI draft" : shown.source === "repair" ? "Repaired" : "Edited as JSON"}
              </span>
              <Btn
                size="sm"
                kind="ghost"
                onClick={() => {
                  setJson(JSON.stringify(shown.ruleset, null, 2));
                  setEditJson((v) => !v);
                }}
              >
                {editJson ? "Close JSON" : "JSON"}
              </Btn>
            </div>
          </div>
          <div className="card-b stack" style={{ gap: 10 }}>
            <p className="small muted" style={{ margin: 0 }}>
              Written from a fixed template, not by the AI. Spendproof checks these rules exactly as written, not what you meant, so read them.
            </p>
            {editJson ? (
              <>
                <textarea className="input json" value={json} onChange={(e) => setJson(e.target.value)} aria-label="Rules JSON" spellCheck={false} />
                <div className="row">
                  <Btn
                    size="sm"
                    kind="primary"
                    busy={busy === "saveJson"}
                    onClick={() => {
                      let parsed: unknown;
                      try {
                        parsed = JSON.parse(json);
                      } catch {
                        run("saveJson", { type: "saveJson", json: "not json" });
                        return;
                      }
                      run("saveJson", { type: "saveJson", json: parsed }, { then: () => setEditJson(false), toast: "Saved as a new draft." });
                    }}
                  >
                    Save as new draft
                  </Btn>
                  <span className="tiny muted">Validated with zod: integer cents, known recipients, no skip rule on a guaranteed payment.</span>
                </div>
              </>
            ) : (
              <ul className="rules">
                {shown.english.map((r) => (
                  <li key={r.id} className={`rule ${core.has(r.id) ? "core" : ""} ${changed.has(r.id) ? "added" : ""}`}>
                    <div className="t">
                      {r.title}
                      {core.has(r.id) ? <span className="flag breach">In the clash</span> : null}
                      {changed.has(r.id) ? <span className="flag proof">{r.kind === "skip" ? "Added" : "Changed"}</span> : null}
                      <span className="kind">{kindLabel[r.kind]}</span>
                    </div>
                    <div className="x">{r.text}</div>
                  </li>
                ))}
              </ul>
            )}
            {shown.unsupported.length ? (
              <div className="callout warn">
                <b>Not expressible as rules, so not included:</b> {shown.unsupported.map((u) => `“${u}”`).join(", ")}
              </div>
            ) : null}
            {isDraft && !shown.confirmed ? (
              <div className="row wrap">
                <Btn kind="primary" size="lg" busy={busy === "confirm"} onClick={() => run("confirm", { type: "confirm", id: shown.id })}>
                  <Icon name="check" /> These are my rules
                </Btn>
                <span className="hero-note">Confirming is what Z3 checks next.</span>
              </div>
            ) : isDraft ? (
              <div className="row small" style={{ color: "var(--proof)" }}>
                <Icon name="check" /> Confirmed by you{shown.source === "repair" ? " (via the repair you applied)" : ""}.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
