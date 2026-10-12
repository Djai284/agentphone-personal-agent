# Iteration log

What I tried, what I saw, what I changed, and why. Newest first.

## 2026-10-11: a correct fallback graded as "failed"

Request (via Claude): "Ask whether outdoor seating is available for my Friday 7:30 pm reservation. If it is, move
it outdoors; **if not, cancel it** and confirm the cancellation." No outdoor seating, so the agent cancelled, and
the restaurant said "Sure. Done."

What I saw: the outcome came back `failed`, saying the reservation was cancelled "without your instruction". The
result text advised calling back to reinstate the booking.

Cause: the voice agent is given the whole request, including `if_not_possible`, but the grader was only shown the
goal, constraints and questions. Doing exactly what the fallback said looked to the grader like going off-script.
The shareable details (callback number etc.) were missing from the grader's view in the same way.

Change: `describeRequest()` in `ai/outcome.ts` gives the grader the full request (fallback and shareable details
included), plus a rule that carrying out the fallback counts as following instructions (`not_possible`, with the
fallback's result under confirmed). Re-graded the same transcript: `not_possible`, "your reservation was cancelled
as you asked", with the cancellation under confirmed.

Lesson: whatever the voice agent is allowed to do, the grader has to be told too, or correct behavior gets
flagged.

## 2026-10-11: too many questions at once, and 8 PM accepted

What I saw (live calls, Jai playing the restaurant):
- The first real turn bundled everything: "…under the name Manav. Also, is outdoor seating available? And before we
  confirm, does this reservation require any deposit?" That's hard to follow on the phone.
- When the restaurant offered only 8 PM against a 6:30 to 7:30 window, the agent **booked it**. The grader caught it
  (`partially_succeeded`: "outside your requested window; the assistant accepted it anyway"), but this is exactly
  the case the brief calls out. The window lived only in the task text, while "Hard constraints" listed just the
  deposit rule, so the model treated the time as negotiable.

Changes (prompt only, `packages/core/src/voice/outbound.ts`):
- "How to run the call" became **"The conversation, step by step"**: open with only the main question, settle the
  exact value, then each condition (deposit, fee), then the extra questions, then read back, then goodbye. One
  question per turn, with a bad/good example of bundling.
- **"Limits"** replaces "Hard constraints" and states that the goal's own specifics (date, time window, party size,
  service) are limits. Anything outside them is an alternative to report back, even if it's the only option.
- "Also find out" now says "later in the call, one at a time".

Checked with a two-Claude simulation (agent on the real prompt, Claude playing the host): the only-8-PM case
declined 8:00 and reported it back; the happy path asked availability, then deposit, then patio, one per turn.
AgentPhone's hosted model isn't Claude, so a live call is the real test.

## 2026-10-11: haircut call requested by text (role confusion)

Setup: Jai texted "can you book a haircut for this weekend?". The intake asked for the shop, its number, the time and
the name, then dialed. Jai played the barbershop and offered 4 PM instead of 3 PM.

What I saw:
- Mid-call, the voice agent invoked our `place_call` **custom tool** (payload in `logs/payloads/`). Custom tools are
  attached to the agent, so they're also offered on the calls it places, not just when someone phones in. The agent
  then acted as the barbershop's assistant: "Would you like me to book Jai for four PM instead?"
- It answered its own confirmation question: "…Is that all set? Thank you! Jai is confirmed…"
- It accepted 4 PM without Jai's approval. The outcome extractor caught this correctly ("4:00 PM, not the requested 3:00 PM").

Changes (prompt-only, plus one guard):
- Outbound prompt, new "Who's who" section: the agent is the caller and works for the requester; the person who
  answers can't approve changes; it has no tools except hanging up.
- Anything different from what was asked (time, day, price, service) is collected and reported back, not accepted.
- After asking a question it must stop and wait; nothing is "confirmed" until the other side says yes.
- The `place_call` tool description now says it's for incoming calls only, and the server refuses it when the
  tool payload's `call.direction` is `outbound`, whatever the model does.

## 2026-10-11: spike call (hosted AgentPhone voice)

Setup: one hosted call to the test phone with a hand-written prompt (a one-off spike script, since removed). The
"restaurant" accepted the request. Fixtures are in `packages/core/test/fixtures/spike-1/`.

What I saw:
- `ringing` → `in-progress` (6 s) → `completed` (52 s). The hosted agent hung up by itself after its goodbye,
  so the built-in `end_call` works with a per-call `systemPrompt`.
- **No exact time was ever agreed.** The agent asked for "between 6:30 and 7:30" and took "that timing works"
  as a booking. The user would have arrived not knowing whether the table was at 6:30 or 7:15.
- **It never asked about a deposit.** The constraint was only "don't accept one", so the agent waited for the
  restaurant to bring it up, which it didn't. A constraint about a hidden condition has to be asked about.
- **"This Friday" was never turned into a date.** For a restaurant that's ambiguous on a Thursday night.
- `GET /calls/{id}` has an empty `transcripts` array until the call ends; `/transcript/stream` (SSE) is
  the only live source. `/transcript` returns clean `{role, content}` turns (the call object instead
  pairs `transcript`/`response` and can merge turns).

Changes:
- Prompt (`src/prompt.ts`): "'That works' is not a confirmation", so the agent pins exact values inside any
  range; it reads back everything agreed before ending; and it asks directly about any condition a constraint
  depends on (deposit, fee, minimum) before agreeing.
- Prompt: today's date plus the next 7 days spelled out ("Friday, October 16"), so the voice model never
  works out weekdays itself, and it's told to say concrete dates.
- Outcome extraction is strict about ranges: a window with no exact agreed value is *unresolved*, not confirmed.
- Live transcript in the CLI uses the SSE stream; the stored transcript comes from `/transcript` after the call.

## Setup decisions
- Hosted AgentPhone voice rather than LiveKit + SIP (as in `opendoor`): no tunnel or worker to run, and the
  spike showed it can follow instructions and hang up.
- The voice agent can't call our code mid-call without a public URL (`customTools` needs HTTPS), so the
  outcome comes from a separate post-call Claude pass over the transcript. That's also a useful check:
  the model grading the call isn't the one that made it.
