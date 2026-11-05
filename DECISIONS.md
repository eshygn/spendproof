# Decisions

Choices made while building Spendproof, and why. Where the brief was ambiguous, I picked the option that makes the demo strongest and kept the claims honest.

## Semantics

- **Two models, two properties.** *Cap* is checked on the rules as written, without the gatekeeper: can a month's total ever go over the limit? *Guarantee* is checked with the gatekeeper enforcing caps in time order, refusing any payment that would push a total over: is a guaranteed payment ever refused? The demo breaks both properties in the same month: January reaches $440, and Sam's 29 January payment would be refused.
- **What a skip rule means.** A skippable payment is skipped when *paid so far + this payment + the fixed payments still due this month* would exceed the cap. Fixed payments are recurring payments that no skip rule targets, plus one-offs in the rules. Looking ahead is what makes "skip the extras in any month where they'd break the cap" protect Sam's later Fridays. Without it, an extra paid on 2 January would starve Sam's payment on 29 January.
- **Guaranteed payments can never be skip targets.** The schema enforces this (a skip rule on a guaranteed payment is a validation error), so the only way a guaranteed payment is missed is a cap refusal. That is what the guarantee property checks.
- **Ordering within a day:** one-offs, guaranteed recurring, skippable recurring, extras, then rule order. The simulator, the Z3 encoding and the scheduler all use the same plan, so they never disagree.
- **Day 29–31 of the month** falls on the last day of shorter months, and the template English says so.
- **Uncertain events are per-day Booleans** for each conditional extra (365 a year for one extra). An extra counts against its monthly maximum only when it is actually paid.
- **One-off payments proposed by the agent** are checked against caps *with room reserved for the fixed payments still due this month*. A one-off that fits today but would cause a guaranteed payment to be refused later is blocked (`cap_reserve`). This keeps the proof for the rules valid while one-offs happen.
- **Funded balance is a system check, not a rule.** The gatekeeper reports it only when the rules would otherwise allow the payment, so rule violations are always named first. For the landlord email, the gatekeeper names three rules: approved recipients, the $400 cap and approval over $100.

## The unsat core has four rules, not three

The brief expected the core to name three rules (Sam's guaranteed Fridays, the big-shop extras and the overall cap). The arithmetic says Ava's $150 retainer is part of the clash: 5 × $50 + 2 × $20 + $150 = $440, and without Ava, January peaks at $290. Z3's core, shrunk to a **minimal** core by deletion, therefore names four rules, and dropping any one of them removes the clash. I kept what Z3 proves instead of hiding a rule to match the script. DEMO.md calls this out as a strength.

## Verification engineering

- **One Z3 proof per month shape.** Two months with the same shape (the same ordered sequence of payments, a run of identical extras-only days cut to the extras' combined monthly maximum, and the same prior history) have exactly the same reachable outcomes. One Z3 proof covers both, and the UI notes it. 12 months collapse to 5 shapes, so the demo verifies in about 1–2 seconds on a laptop. A test checks that verdicts and worst cases are identical with sharing on and off.
- **A redundant at-most lemma** (each extra is paid at most `maxPerMonth` times) is added to the encoding. It is implied by the sequential count and cut proof times about 5×.
- **Repair search** uses `holds()`: one Z3 query per month shape asking whether any cap is exceeded. It skips the guarantee query because "caps hold" implies "no guaranteed payment is refused" (amounts are positive, so a running total never exceeds the final total). A randomised test checks that implication. A repair is re-verified in full, with both properties, when applied.
- **The binary search** probes an arithmetic estimate first (the excess divided by the payment's occurrences in the failing month), so it usually settles in two checks. It then falls back to a plain binary search, to the dollar when amounts are whole dollars.
- **Worst case per month** uses Z3 `Optimize` (maximise the total). Only the month whose story is told also minimises the number of events, so the counterexample is the cleanest one.
- **Counterexample replay:** events that changed nothing (over the monthly maximum) are dropped. The simulator must reproduce the violation both before and after that clean-up, or a `ReplayMismatchError` is raised and nothing is shown.
- **Time limit:** each Z3 query has a 15 s timeout. `unknown` fails closed: the rules are not verified and cannot be activated.
- **Verification horizon** starts at the first day the scheduler has not run yet, and includes payments already made earlier in that month.

## Product

- **Confirm, then verify.** Verification is disabled until the person confirms the template English. Applying a repair counts as confirming, because the repair card shows the exact template sentence being added.
- **Activation requires** a confirmed draft whose latest verification is `verified` for exactly its rules hash. Every payout stores the rules version (`rv_` + the first 10 hex characters of the SHA-256 of the canonical rules JSON) that allowed it.
- **The scheduler runs at the end of each day.** Jumping the clock from 1 Nov to 29 Nov pays 1–28 Nov. That covers Ava's retainer, Sam's four Fridays and two big-shop extras, $390 in total, in seven daily batches.
- **A failed payout is shown and retryable once.** The demo makes PayPal refuse the first batch after a reset, using PayPal's sandbox negative testing (`PayPal-Mock-Response` with `INSUFFICIENT_FUNDS`, a real PayPal sandbox response). This shows the failure path without faking a PayPal response. There is a switch to turn it off.
- **Funding through PayPal Checkout.** The brief asks for the PayPal JS SDK buttons "wherever a person pays". In Spendproof the person pays only when topping up the balance that payouts are drawn from, so that is where the buttons are. The seeded scenario starts with a $400 October top-up, so November runs without a checkout step in the video.
- **Messages are dated 1 Nov** (the demo start), so the agent's proposals are evaluated "today".
- **Recipients in the demo are fictional `example.com` addresses.** In the live sandbox those payouts end `UNCLAIMED` (`RECEIVER_UNREGISTERED`), which is PayPal's real behaviour. `SANDBOX_RECEIVER_SAM` / `SANDBOX_RECEIVER_AVA` swap in real personal sandbox accounts, and the seeded messages and recorded responses follow the override.
- **`PAYPAL_SANDBOX_BUYER_EMAIL` in this environment belongs to the app's own business account.** A payout to it failed with `SELF_PAY_NOT_ALLOWED`, so it is not used as a payout receiver.

## AI

- **Model:** `AI_MODEL` was empty. `gemini-3.8-flash` is the newest Flash model the API lists. During development it often returned 503 (overloaded) and 429 (free-tier quota), so the adapter tries it first, then `gemini-2.5-flash`, then the recorded responses. Each step is reported in the status chip.
- **Flat tool schema.** Gemini's function declarations handle plain objects with enums and nullables much more reliably than unions. The authoring tool is flat, and code converts it into the discriminated-union rules JSON.
- **`unsupported` field.** The model must quote any instruction it can't express, rather than silently dropping it. The app shows those quotes.
- **Thinking is turned down** (`thinkingBudget: 0` on 2.5, `thinkingLevel: low` on 3.x). Filling a tool schema needs little reasoning, and lower latency matters in a demo.
- **No free-text fallback parser.** In mock mode, only the sample sentence and the two sample messages have recorded responses. Other input gets a clear error that suggests the sample or the JSON editor. A regex "AI" would misrepresent what the product does.

## Stack and environment

- **Next.js 16 (App Router), React 19, TypeScript 5.9.** TypeScript 7 is current on npm, but Next's type-check tooling targets 5.x, so the project pins 5.9.3.
- **Plain CSS with design tokens** (no Tailwind): a "ledger" palette of paper, ink, proof green and breach vermilion, with Fraunces, Geist and Geist Mono through `next/font`.
- **One action endpoint** (`POST /api/action`, a zod-validated discriminated union) and one state endpoint. This keeps the client simple and every server action typed.
- **Bryntum, AG Grid and "Clockout"** appear in the shared environment and brief template but have nothing to do with Spendproof. None of them is a dependency, so `npm install` needs no private registry or licence. `BRYNTUM_EMAIL` and `AG_GRID_LICENSE_KEY` are ignored.
- **Network:** the PayPal sandbox and the Gemini API were both reachable from the build environment, so no host had to be switched to its mock. Both adapters still fall back to mocks automatically when a host doesn't answer.
- **Render free plan:** 0.1 CPU and an ephemeral disk. SQLite lives in `/tmp` and is re-seeded on boot. Z3 is noticeably slower there, which the README says.

## Second review (4 Nov): what was checked and what changed

Each point below was checked against the code before anything changed.

### Stored proofs for the hosted demo: real, implemented differently

- **The problem is real.** Render's free plan has 0.1 CPU. Verification takes about 1 to 2 seconds on a laptop, so on that plan expect tens of seconds. Each Z3 query has a 15 s limit and `unknown` fails closed, so a judge could see "not verified" under load. I could not measure Render itself from here.
- **What I built.** A verification whose input exactly matches a proof Z3 already produced is reused and labelled "proved earlier for these exact rules", with a "Run Z3 again" button. Proofs come from `fixtures/proofs` (the demo rules and the repaired rules) or from earlier runs on the same server.
- **Changes from the suggestion:**
  - **Off by default.** It is on only where `SPENDPROOF_STORED_PROOFS=1` is set, which is `render.yaml`. Local runs and the demo video always run Z3 live, so "fails in about a second" stays true on camera.
  - **Not keyed on the rules hash.** The rules hash includes recipient emails, so the `SANDBOX_RECEIVER_*` overrides would change it and every lookup would miss. The key (`src/domain/proofKey.ts`) covers what the proof depends on: rules, recipient IDs, start date, horizon length, payment history and a verifier version.
  - **Stored repairs are re-attached to the current recipients** before use, so applying one never swaps your sandbox emails back to the demo ones.
  - **Fixtures can't go stale silently.** `tests/proofs.test.ts` recomputes every stored proof (and its repairs) with live Z3 and fails on any difference. `npm run proofs:record` regenerates them.
- **Found while doing this: the counterexample was not deterministic.** Z3 may return any event days that break the cap. Depending on what ran earlier in the same Z3 context, it sometimes chose a big shop on 30 January, after Sam's last Friday. The cap still broke, but "Sam's 29 Jan payment would be refused" disappeared from the story. The story optimisation now also minimises the event days, which makes the counterexample unique: big shops on 1 and 2 January, $440, Sam refused on 29 January. A test runs it twice in one context and checks the story is identical.

### Sandbox receivers ending SUCCESS: real, not fixable from here

- With `SANDBOX_RECEIVER_SAM` and `SANDBOX_RECEIVER_AVA` set (both values checked: no spaces or quotes), seven live payouts still ended `UNCLAIMED` with `RECEIVER_UNREGISTERED`. PayPal's sandbox does not recognise those two addresses. The likely cause is that they belong to a different developer login from the REST app's credentials.
- I did not change the fixtures or docs to claim `SUCCESS`, because it was never observed. The mock fixture already uses PayPal's documented `SUCCESS` response shape.
- The README now says the receivers must be personal sandbox accounts from the same developer login as the app.

### Trim the opening narration: real, done

- The old scene-one line was 48 words, about 19 to 20 seconds at a normal pace, which leaves no room inside 20 seconds. It is now about 35 words.
- I dropped "Spendproof fixes both", because the next scene shows it instead of saying it.

### The product critiques in the spec review

- **"Eat your vegetables."** This is partly right for the grand prizes, but the listed judges are mostly PayPal developer advocates and engineers plus sponsor engineers, and the demo has a villain: the phishing email fails live. That is a pitch question, not a code change.
- **The gap between what you said and what the rules say.** This is real and can't be closed, which is why the product doesn't claim to. The rules are shown in template English (not written by the model) and confirmed by the person. Anything the model couldn't express is listed back. Every claim in the UI and README says "verifies the rules you confirmed, not your intent". No change.
- **"Why not SQL?"**
  - Enforcement *is* the SQL-style check: the gatekeeper sums the month's payments and compares them with the cap.
  - The solver earns its place with things a running total can't do before any money moves: the interplay of guaranteed payments, skippable extras and a cap across every possible event sequence; a minimal unsat core naming the colliding rules; and repairs that are proved before they are offered.
  - Honest residual: a hand-written worst-case simulator could also find January 2027 for this particular demo. We don't claim otherwise. A randomised test checks that Z3 and the simulator agree. No change.
- **"PayPal use is the thinnest, only Payouts."** Out of date. The app also uses Orders v2 through `@paypal/paypal-server-sdk` with the JS SDK buttons for top-ups, plus sandbox negative testing for the failure path.
- **Where the spec and the build differ, on purpose:**
  - **Gemini, not Claude.** The build brief required Gemini.
  - **Seven rule kinds**, because the skip rule is its own kind.
  - **The gatekeeper names three rules** for the landlord email: approved recipients, the $400 cap and approval over $100.
  - **The unsat core has four rules** (see above).

### From the hackathon page

- The video must be under 3 minutes. The script targets 2:45.
- Render sponsors three "Best Use of Render" prizes, so the hosted copy matters, which is a second reason for stored proofs.

## Final audit (5 Nov)

Checked from a clean clone of `main`:
- `npm install`, lint, typecheck, 49 tests and the production build all pass.
- The full demo story was driven in a real browser against `next start`, twice: with no keys at all (mock), and with the live keys (PayPal sandbox and Gemini).

**Works end to end live**
- Z3 verify, counterexample, core, repairs and re-verify.
- Gemini rule drafting (`gemini-2.5-flash`; 3.8 was over quota).
- Sandbox batch payouts with polling.
- The injected `INSUFFICIENT_FUNDS` failure and its retry.
- The gatekeeper blocking the landlord payment (three rules named) and allowing the $45 invoice with $350 reserved.
- The skip rule skipping both November extras after that invoice: Sam got every Friday, and November closed at $395.
- Creating a Checkout order.

**Not verified live, and why**
- **Payouts ending `SUCCESS`.** The configured receivers return `RECEIVER_UNREGISTERED`.
- **Capturing a Checkout order.** It needs a sandbox buyer to approve it in the popup; the capture path is exercised in mock mode only.
- **The live inbox agent.** Gemini returned 429 on both models during the run, so the recorded response was used and the chip said so.

**Fixed in this pass**
- **Readable PayPal SDK errors.** `ApiError` from the server SDK arrives with an empty message, so a failed capture showed a blank error. PayPal's own issue and description (for example `ORDER_NOT_APPROVED`) are now passed through.
- **The demo failure lands on a scheduled payout.** The "refuse the next batch" switch could fire on whichever batch went next, such as an approved one-off. It now applies only to the scheduler's daily batches, so the story always plays the same way.
- **The mock `INSUFFICIENT_FUNDS` fixture** now carries the message the live sandbox actually returned.
- **Docs.** Everything the code can't back up was corrected, and the README gained a "What's real, what's simulated, and known limits" section.

**Weak points left as they are, stated plainly**
- **No `SUCCESS` payouts yet.** That needs registered sandbox receivers on the owner's side.
- **The approval step is never reached in the demo story.** With the $400 cap, a one-off over $100 always fails the room-reserved check first. It is covered by unit tests only.
- **No sign-in.** One shared demo state per deployment.
- **The Render deploy is untried.** The free plan's 512 MB memory is a risk for `next build`.
- **Verification takes 1 to 3 seconds**, not the brief's "about a second".
