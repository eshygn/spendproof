# Demo video: shot list and voiceover script

**Target length:** 2:45 (hard limit 2:50). About 400 spoken words at a calm pace.

**How this is made:** the screen is recorded silently and an AI voice reads the narration. Do it in this order:

1. Record the screen first, following the shots below at a relaxed pace. Don't try to hit the timings exactly; a take of up to about 3:15 is fine, since pauses get trimmed.
2. Fit the narration to the recording: note when each shot starts, then shorten or pad the matching paragraph of the **Voiceover text** at the bottom of this file so it fits that shot.
3. Paste the fitted text into the AI voice tool and export the audio, one file per paragraph if the tool allows it, so each can be placed at its shot.
4. Put the audio under the recording in any video editor, trim the dead time, and export at 2:50 or under.

**Recording setup:** 1440 × 900 browser window, dark mode (the app follows the system or browser theme), zoom 100%, no microphone. Use the hosted site, <https://spendproof.onrender.com>, or run locally with live keys (`npm run dev`). The header chips should read **PayPal Sandbox · live** and **AI gemini-…**. If Gemini is busy, the recorded fallback looks the same apart from the AI chip and the agent's "recorded response" label. Do one full practice run first so the Gemini response is cached and Z3 is warm, then click **Reset demo** before the real take; that also re-arms the PayPal failure for the first scheduled batch. Move the mouse slowly, and after each click hold still for two seconds so the screen can be read.
**On-screen captions** (optional, lower third, in brackets below) mark each PayPal moment; add them in the editor.

---

### 0:00–0:20 · The problem and who it's for

**Shot:** the Spendproof home screen, empty composer with the sample sentence. Hold still.

> "I want an AI to handle money I send people: my flatmate's groceries, my bookkeeper's retainer. But plain-English rules hide edge cases, and an agent with payment credentials can be talked into paying anyone."

### 0:20–0:42 · Rules as data, read back from a template

**Shot:** click **Turn into rules**. The rules list appears. Hover over the "Written from a fixed template, not by the AI" line, then click **These are my rules**.

> "I type my rules once. Gemini fills a strict tool schema, and Spendproof turns that into rules as data: money in cents, days on the calendar. What I read back isn't written by the AI. It comes from a fixed template, and I confirm it. Spendproof verifies the rules I confirmed, not what I meant, so I read them."

### 0:42–1:18 · Z3 finds the clash today

**Shot:** click **Verify with Z3**. The red verdict appears. Pan down: month chart (Jan, Apr, Jul and Oct bars red), the January table, the callout, the list of colliding rules. On the left, the four rules are marked "In the clash".

> "Z3 checks every possible sequence of events for the next twelve months. Every day Sam might do a big shop is a free Boolean. It fails in a couple of seconds: January 2027 has five Fridays, so the month can reach four hundred and forty dollars against a four-hundred cap. With the cap enforced, Sam's guaranteed payment on the 29th would be refused.
> The obvious question: why not just check the database? A database check refuses Sam's money on 29 January. Spendproof finds the clash today, 89 days early, and the unsat core names the rules that collide. Notice it's four, not three: Ava's retainer is part of the arithmetic, and dropping any one of these rules removes the clash."

### 1:18–1:40 · One-click repair, then a proof

**Shot:** the Repairs card (skip rule on top; "Largest safe amount $42.00" below). Click **Apply** on the skip rule. The green verdict, chart all green, two "proved" rows and the claim sentence.

> "Spendproof offers repairs that Z3 has already checked. It found the largest safe amounts by binary search. I add one rule: skip the extras in any month where they'd break the cap. Verified. For every possible sequence of events in these twelve months, the cap holds and Sam never misses a Friday. That's the whole claim, and nothing more."

### 1:40–1:48 · Go live

**Shot:** click **Activate rules**. The app moves to the Inbox tab.

> "Now a deterministic scheduler, not the AI, will pay these rules."

### 1:48–2:15 · The untrusted agent gets fooled; the gatekeeper doesn't

**Shot:** the Harbour Lane Lettings email. Click **View source**: the hidden white text is highlighted. Click **Ask the agent to handle it**. The agent's reply, the $1,800 proposal, and the red gatekeeper panel listing three rules.

> "Here's a phishing email from my 'letting agent', with an instruction hidden in white text. The chat agent reads my inbox, and it's fooled: it proposes eighteen hundred dollars to a new account. But it has no PayPal credentials. Everything it proposes goes through the gatekeeper, which blocks this and names the rules it breaks: not an approved recipient, over the monthly cap, and over the approval limit."

### 2:15–2:40 · Real PayPal payouts, stamped with the rules version

**Shot:** click **+4 weeks** on the demo clock. The Payouts tab: rows appear (Pending → Paid), each with an `rv_…` rules version and its PayPal batch ID. The 1 Nov row says **Failed: INSUFFICIENT_FUNDS**. Click **Retry**, and the retry row appears and goes to Pending.
**Captions:** [PayPal Payouts API · batch payout per day] → [Status polled from PayPal] → [PayPal refused a batch, so the gatekeeper re-checks and we retry]

> "I jump the clock four weeks. The scheduler sends November through PayPal Payouts, one batch a day, and every payout is stamped with the rules version that allowed it. Statuses come straight back from PayPal. One batch was refused by PayPal, so I retry it, and the gatekeeper re-checks it against the real payment history first."

### 2:40–2:48 · Close on impact

**Shot:** scroll so the full screen shows: the activity feed, the balance and the month meter at $390 / $400.

> "Spendproof lets you hand money to an AI agent with rules that are proved before they run and enforced on every payout. Clashes show up months early, and a fooled agent can't pay anyone."

---

## Shot checklist

- [ ] Reset demo; chips show live PayPal + Gemini (or note the recorded fallback).
- [ ] Composer pre-filled with the sample sentence.
- [ ] Counterexample: January 2027, $440, Fri 29 Jan refusal, "89 days early", 4-rule core highlighted on the left.
- [ ] Repairs card visible with the skip rule on top.
- [ ] Verified: both properties "proved", claim sentence visible.
- [ ] Landlord email with **View source** showing the hidden instruction.
- [ ] Gatekeeper panel: Approved recipients, $400 monthly total cap, Approval over $100.
- [ ] +4 weeks: 7 payouts plus a failed batch; Retry clicked; rules-version stamps visible.
- [ ] Captions for each PayPal moment (optional, added in the editor).
- [ ] No microphone audio in the recording; voiceover laid under it afterwards.

---

## Voiceover text

Paste everything below into the AI voice tool as one piece. It is the same narration as above, with numbers and names spelled the way they should be said. Pick a calm, natural voice; each blank line is a short pause.

I want an AI to handle money I send people: my flatmate's groceries, my bookkeeper's retainer. But plain-English rules hide edge cases, and an agent with payment credentials can be talked into paying anyone.

I type my rules once. Gemini fills a strict tool schema, and Spendproof turns that into rules as data: money in cents, days on the calendar. What I read back isn't written by the AI. It comes from a fixed template, and I confirm it. Spendproof verifies the rules I confirmed, not what I meant, so I read them.

Zee three checks every possible sequence of events for the next twelve months. Every day Sam might do a big shop is a free Boolean. It fails in a couple of seconds: January twenty twenty-seven has five Fridays, so the month can reach four hundred and forty dollars against a four-hundred cap. With the cap enforced, Sam's guaranteed payment on the twenty-ninth would be refused.

The obvious question: why not just check the database? A database check refuses Sam's money on the twenty-ninth of January. Spendproof finds the clash today, eighty-nine days early, and the unsat core names the rules that collide. Notice it's four, not three: Ava's retainer is part of the arithmetic, and dropping any one of these rules removes the clash.

Spendproof offers repairs that Zee three has already checked. It found the largest safe amounts by binary search. I add one rule: skip the extras in any month where they'd break the cap. Verified. For every possible sequence of events in these twelve months, the cap holds and Sam never misses a Friday. That's the whole claim, and nothing more.

Now a deterministic scheduler, not the AI, will pay these rules.

Here's a phishing email from my letting agent, with an instruction hidden in white text. The chat agent reads my inbox, and it's fooled: it proposes eighteen hundred dollars to a new account. But it has no PayPal credentials. Everything it proposes goes through the gatekeeper, which blocks this and names the rules it breaks: not an approved recipient, over the monthly cap, and over the approval limit.

I jump the clock four weeks. The scheduler sends November through PayPal Payouts, one batch a day, and every payout is stamped with the rules version that allowed it. Statuses come straight back from PayPal. One batch was refused by PayPal, so I retry it, and the gatekeeper re-checks it against the real payment history first.

Spendproof lets you hand money to an AI agent with rules that are proved before they run and enforced on every payout. Clashes show up months early, and a fooled agent can't pay anyone.
