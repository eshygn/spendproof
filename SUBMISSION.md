# Devpost submission (draft)

**Project name:** Spendproof
**Tagline:** Spending rules for an AI payment agent, proved with Z3 before any money moves and enforced on every PayPal payout.
**Prize tracks:** Best Use of Agentic Commerce · Most Creative · Best Use of PayPal + AI · Best Use of Render

---

## Inspiration

We wanted to let an AI agent handle the money we send to other people: a flatmate's grocery money, a contractor's retainer. Two things stopped us. The rules people write in plain English have edge cases nobody spots. "$50 every Friday, never skip it" plus a $400 monthly cap works for months, until a month with five Fridays. And an agent that holds payment credentials can be talked into paying anyone by one convincing email. We wanted the rules checked before they run, and an agent that can't move money on its own.

## What it does

- You write your rules in plain English. Gemini fills a strict tool schema, and Spendproof turns that into **rules as data**: seven rule kinds, money in integer cents, time in calendar days. The rules are shown back to you **from a fixed template, not by the AI**, and you confirm them.
- **Z3 verifies the confirmed rules** over the next 12 months. Every day an uncertain event could happen is a free Boolean, so the check covers every possible sequence of events. For every month it proves, or refutes, two properties: no cap is ever exceeded, and no guaranteed payment is ever skipped.
- On failure you get the **earliest counterexample** (dates, payments, running totals), replayed through a TypeScript simulator before it is shown, plus the **unsat core**, the minimal set of rules that collide. In the demo: January 2027 has five Fridays, so the month can reach $440 against a $400 cap, and Sam's guaranteed payment on 29 January would be refused. Spendproof finds that 89 days early.
- **Repairs** are verified before they are offered: add a skip rule, or the largest safe amount and the smallest safe cap found by binary search with repeated Z3 checks. One click and Z3 proves the repaired rules.
- Once the rules are verified, a **deterministic scheduler** pays them through **PayPal Payouts** (batch payouts, status polling, failed payouts shown and retryable). Every payout is stamped with the hash of the rules version that allowed it.
- A **gatekeeper** re-checks every payout against the rules and the actual payment history before calling PayPal.
- A separate **untrusted chat agent** reads your inbox and can only *propose* payments. It has no PayPal credentials. When a phishing email with a hidden instruction fools it into proposing $1,800 to a new account, the gatekeeper blocks the payment and names the three rules it breaks.
- You top up the balance that payouts draw from with **PayPal Checkout** (JS SDK buttons + Orders v2). The balance is Spendproof's own ledger of top-ups and payouts.

## How we built it

- **Next.js 16 (App Router) + TypeScript**, one Node service. SQLite through better-sqlite3, seeded on boot, with a demo clock that jumps forward and a Reset button.
- **Z3** (`z3-solver` WebAssembly), server only and initialised once. The calendar is computed in TypeScript. Each month is encoded with per-day event Booleans, running totals, skip-rule and cap-enforcement constraints, tracked assertions for unsat cores (shrunk to a minimal core), and `Optimize` for the worst-case chart. Months with the same shape share one proof, so 12 months need 5 proofs and verification takes one to three seconds on a laptop.
- **A plain TypeScript simulator** is the reference semantics. Every Z3 counterexample is replayed through it at runtime and in tests, and a randomised test checks that Z3 and the simulator agree on generated rulesets.
- **Gemini via the Vercel AI SDK**, using tool calls with zod schemas only: `record_rules` for authoring, `propose_payment` for the inbox agent. Responses are cached and rate-limited, with a fallback model and recorded responses when the API is busy.
- **PayPal:** `@paypal/paypal-server-sdk` for OAuth and Orders v2 (top-ups), the Payouts REST API for batch payouts and polling, sandbox negative testing for a real failure path, and `@paypal/react-paypal-js` buttons loaded client-side only.
- Every external service sits behind an adapter with a live and a mock implementation. The mock is backed by fixture JSON shaped like the documented responses, and status chips show which mode is active.
- 49 Vitest tests cover money maths, the calendar, the rule and AI tool schemas, the simulator, Z3 counterexamples and proofs, repairs, the gatekeeper, the payout state machine and the stored proofs.

## Challenges we ran into

- **Making "skip" mean something precise.** "Skip the extras in months where they'd break the cap" only protects Sam's last Friday if the skip rule looks ahead at the fixed payments still due. We had to pin that down in the simulator and the encoding together.
- **Speed.** Our first encoding took 12 seconds. A redundant at-most lemma and sharing one proof across months of the same shape brought it to one to three seconds without weakening what is proved. A test checks that sharing doesn't change any verdict.
- **Honest unsat cores.** The script we wrote said three rules collide. Z3 says four, because Ava's retainer is part of the arithmetic. We minimised the core and showed what Z3 proves.
- **Gemini's free tier** was often overloaded or over quota while we built. The adapter falls back from model to model and then to recorded responses, and says so on screen.
- **A nondeterministic story.** Z3 may return any event days that break a cap, and sometimes it picked days that hid the "Sam's Friday would be refused" part of the counterexample. We added a final "earliest days" objective so the same rules always produce the same counterexample.

## Accomplishments that we're proud of

- A counterexample a person can read: dates, payments, a running total crossing the cap, and the exact rules to blame. Shown 89 days before a database check would notice.
- A precise claim: "for every possible sequence of events in this horizon, for these rules as confirmed", and nothing more.
- An AI agent that gets fooled on camera and still can't move a cent.
- Real sandbox payouts, each traceable to the rules version that allowed it. With two personal sandbox accounts as receivers, they end paid.

## What we learned

- Formal verification is approachable when the domain is small and the calendar is computed outside the solver. Z3 only has to reason about Booleans and sums.
- The safest place for an LLM in a payment flow is at the edges: turning English into a schema, and reading messages. Code decides what is allowed and does the paying.
- Every counterexample deserves a second, boring implementation to confirm it. Having the simulator, plus a randomised test that checks Z3 against it, is what let us optimise the encoding aggressively without fear.

## What's next

- More rule kinds people actually use: date ranges, pausing a payment, and splitting a bill between flatmates.
- Re-verifying automatically as payment history and one-off payments change what is left in a month.
- Real recipients with PayPal accounts linked through Log in with PayPal, and Payouts webhooks instead of polling.
- An approval flow on the phone: the gatekeeper's verdict, one tap to approve.

## Built with

TypeScript · Next.js · React · Node.js · Z3 (z3-solver) · Vercel AI SDK · Google Gemini · PayPal Payouts API · PayPal Orders v2 · @paypal/paypal-server-sdk · PayPal JS SDK (@paypal/react-paypal-js) · SQLite (better-sqlite3) · zod · Vitest · Render
