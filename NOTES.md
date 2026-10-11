# Iteration log

What I tried, what I saw, what I changed, and why. Newest first.

## 2026-10-11: spike call (hosted AgentPhone voice)

Setup: one hosted call to the test phone with a hand-written prompt (`scripts/spike.ts`). The
"restaurant" accepted the request. Fixtures are in `test/fixtures/spike-1/`.

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
