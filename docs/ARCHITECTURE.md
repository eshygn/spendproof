# Architecture

Spendproof is one Next.js (App Router) service. The browser calls two endpoints: `GET /api/state` for a snapshot, and `POST /api/action` for every command, as a zod-validated union. Everything that matters happens on the server, in two layers:

- `src/domain/`: pure TypeScript with no I/O. Rules, calendar, simulator, Z3 encoding, repairs, gatekeeper. This is what the tests cover.
- `src/server/`: state (SQLite), the scheduler, and the adapters for PayPal and Gemini, each with a live and a mock implementation.

```
plain English ──Gemini tool call──▶ authoring.ts ──▶ rules JSON (zod) ──▶ template English ──▶ person confirms
                                                         │
                                                         ▼
                                         verify.ts (Z3) ◀──replays──▶ simulate.ts
                                                         │ verified + activated
                                                         ▼
 inbox agent ──propose_payment──▶ gatekeeper.ts ◀── service.ts scheduler (runDay) ──▶ PayPal Payouts
```

## The five files that matter most

### 1. `src/domain/verify.ts`: the proof

Encodes each calendar month for Z3 and checks two properties per month.

- **Cap:** without the gatekeeper, can any sequence of events take a cap's total over its limit?
- **Guarantee:** with the gatekeeper enforcing caps in time order, is a guaranteed payment ever refused?

`sat` gives a counterexample, which is replayed through the simulator and shown only if confirmed. `unsat` is the proof.

Key decisions:
- **One free Boolean per day per conditional extra.** This is what "every possible sequence of events" means concretely: 365 per extra per year.
- **Unsat core with tracking literals.** Each rule's constraints sit behind its own literal. The counterexample's events are fixed, the property is asserted, and Z3 is asked for the literals it needed. The core is then shrunk by deletion until it is minimal, so the UI can truthfully say "drop any one of these and the clash disappears".
- **Speed without weakening the claim.** A redundant at-most lemma per extra, and one proof shared by months with the same shape (a test checks that sharing never changes a verdict).
- **Deterministic story.** The counterexample shown is the worst case, then the fewest events, then the earliest days. It is unique, so the same rules always tell the same story.
- **Fails closed.** Every query has a 15 s timeout, and `unknown` means "not verified": the rules can't be activated.

### 2. `src/domain/simulate.ts` (with `plan.ts`): the reference semantics

Plain, step-by-step TypeScript that defines what the rules *mean*. `plan.ts` computes the calendar (Fridays, month ends, the 31st clamped to short months) and orders each month's payment instances. `decide()` then applies the rules to one instance.

Key decisions:
- **One plan feeds everything.** The simulator, the Z3 encoding and the live scheduler all use it, so they can't disagree about which day is a Friday.
- **Skip rules look ahead.** A skippable payment is dropped when paid-so-far + this payment + the fixed payments still due this month would exceed the cap. Without the look-ahead, an extra paid on 2 January would starve Sam's payment on 29 January.
- **The same `decide()` runs in production.** The scheduler and gatekeeper call it on the real payment history, so what was proved is what runs.

### 3. `src/domain/gatekeeper.ts`: the last check before PayPal

Every payout passes through `evaluatePayout()` first: scheduled ones, retries and the agent's proposals. It returns `allow`, `needs_approval` or `block`, and lists each violation with the rule it breaks.

Key decisions:
- **Only verified rules can pay.** A payout must fall inside the verified horizon of the exact rules version (hash) that is active.
- **The recipient must be approved, with the PayPal account on file.** A known name with a new email is refused. That is the phishing case.
- **Scheduled payments must match their rule exactly:** right amount, right day, not already sent, event reported. They then go through the simulator's `decide()` on the real history.
- **One-offs reserve room** for the fixed payments still due this month. A one-off that fits today but would starve a guaranteed payment later is blocked.
- **Funded balance is checked last,** as a system check, so rule violations are always named first.

### 4. `src/server/service.ts`: orchestration and the scheduler

Owns the lifecycle: draft → confirm → verify → repair → activate. It also runs the scheduler, sends PayPal batches, polls their status, handles retries and runs the inbox agent.

Key decisions:
- **Rules versions.** Each version is `rv_` + SHA-256 of canonical rules JSON. Activation requires a `verified` result for exactly that hash, and every payout row stores it.
- **The scheduler is deterministic code.** When the demo clock jumps, `runDay()` processes each elapsed day "at end of day". It asks the gatekeeper about every due instance, records skips and blocks, and sends one PayPal batch per day.
- **Failed payouts are retryable once.** A failed payout stops counting toward caps and balance. Its retry is a new payout that the gatekeeper checks against the history as it is now.
- **The agent has one door.** It can only call `runAgent()`, which turns proposals into gatekeeper verdicts. Nothing in that path can reach the PayPal adapter except through the gatekeeper's `allow`.

### 5. `src/domain/authoring.ts`: where the AI meets the rules

The zod schemas for the two Gemini tools (`record_rules`, `propose_payment`), the system prompts, and `toRuleset()`, the deterministic converter from tool output to validated rules.

Key decisions:
- **A flat tool schema.** Plain objects, enums and nullables, which Gemini fills more reliably than unions. Code converts it into the discriminated-union rules.
- **The model never writes the text the person confirms.** That comes from the fixed templates in `english.ts`.
- **`unsupported` is mandatory.** The model must quote anything it couldn't express, and the app shows it, so nothing is dropped silently.
- **Integer cents in the schema**, rejected if fractional. The confirmed template English shows `$50.00 USD`, which is the safety net for a cents mistake.

## Supporting files

| File | Role |
|---|---|
| `src/domain/rules.ts` | The seven rule kinds as zod schemas, cross-reference checks, canonical JSON |
| `src/domain/english.ts` | Fixed plain-English templates and short rule titles |
| `src/domain/repairs.ts` | Skip-rule suggestions; largest safe amount and smallest safe cap by binary search over Z3 checks |
| `src/domain/payoutStatus.ts` | Payout state machine mapped onto PayPal's `transaction_status` values |
| `src/server/adapters/paypal.ts` | Live sandbox (server SDK for OAuth and Orders, REST for Payouts) and a fixture-backed mock |
| `src/server/adapters/ai.ts` | Gemini through the AI SDK: fallback model, SQLite cache, 8/min rate limit, recorded responses |
| `src/server/proofs.ts` + `src/domain/proofKey.ts` | Stored proofs for slow hosts (Render only), keyed on what the proof depends on |
| `src/server/db.ts` | SQLite schema, seeding and reset |
| `src/server/z3.ts` | Z3 initialised once, warmed up, every job run through one queue |
| `src/components/*` | The UI: Rules & proof, Inbox agent, Payouts, and the clock/balance/activity rail |

Why each decision was made, and what was rejected: [DECISIONS.md](../DECISIONS.md).
