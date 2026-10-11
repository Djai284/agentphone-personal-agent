# Booking Agent: plan

Ask an AI assistant (over MCP) to phone someone on your behalf, complete a task within your
constraints, and report back through MCP and SMS.

```
MCP client ──place_call──► MCP server ──POST /v1/calls (systemPrompt)──► AgentPhone hosted voice ──► restaurant
    ▲                           │  SQLite: calls, idempotency, events          │
    └────────get_call───────────┤                                              │
                                │◄── poll GET /v1/calls/{id} (+ optional webhook) ┘
                                ├── transcript → Claude (zod schema) → Outcome
                                └── POST /v1/messages → SMS to the user
```

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript** (Node 24, ESM) | The MCP TS SDK takes zod schemas for tool input *and* output (`structuredContent`). The Anthropic TS SDK parses structured output straight into a zod type. One schema gives MCP validation, LLM output, the DB row shape, and the CLI types. |
| Voice | **AgentPhone hosted voice** (`POST /v1/calls` with a per-call `systemPrompt`) | The spec asks for AgentPhone voice. Hosted mode removes LiveKit, SIP trunks and the tunnel from the critical path. `opendoor`'s LiveKit + SIP stack is the fallback if hosted mode can't hang up, detect voicemail, or keep latency acceptable. |
| Result delivery | **Polling first, webhook optional** | `get_call` refreshes from AgentPhone on demand, and a background reconciler finishes in-flight calls. The demo then needs no public URL. An `agent.call_ended` webhook can be added later for push. |
| Outcome | **Post-call extraction with Claude** into a zod `Outcome` | Hosted mode has no custom tools mid-call. A separate pass over the transcript, which must cite evidence quotes, is more honest than the voice agent grading itself. |
| Storage | `node:sqlite` (built in) | One file, no native build, and it survives restarts so in-flight calls can be resumed. |
| Idempotency | `UNIQUE(idempotency_key)` + request hash, row written **before** dialing | Same key + same request returns the existing call. Same key + a different request is a clear error. Concurrent duplicates can't both dial. |

## Domain model (zod, `src/schemas.ts`)

- `PlaceCallInput`: `to` (E.164), `task`, `on_behalf_of` {name, callback phone, other details},
  `constraints[]` (hard rules), `preferences[]` (nice-to-haves / questions to ask), `idempotency_key`,
  optional `notify_phone`.
- `CallStatus`: `queued → dialing → ringing → in_progress → analyzing → completed`, plus
  `no_answer | busy | failed | canceled`.
- `Outcome`: `result: succeeded | partial | not_possible | failed | no_answer`, `confirmed` (key/value
  facts such as date, time, party size, name, deposit), `constraint_checks[]` (constraint, met?, evidence quote),
  `answers[]` (to questions asked), `unresolved[]`, `next_steps[]`, `summary` (1–2 sentences).

## Phases

### 0. Scaffold + API spike
- `package.json`, `tsconfig`, vitest, `.env.example` (reuse the parent `.env` keys), `.mcp.json`.
- Spike script against the real API: place one hosted call to the test number and record the raw
  `POST /v1/calls`, `GET /v1/calls/{id}` and transcript payloads as fixtures. Confirm the status
  values for no-answer/busy/failed, whether a hosted agent can hang up, and SMS from our number.

### 1. Core flow
- `agentphone.ts`: typed client (calls, call, transcript, SSE stream, messages), zod-parsed responses.
- `store.ts`: calls, events, outbound SMS log.
- `prompt.ts`: builds the voice agent's system prompt and greeting from the task.
- `calls.ts`: `placeCall` (validate → idempotency → dial) and `refreshCall` (poll → terminal → analyze → notify once).
- `outcome.ts`: transcript → `Outcome` via Claude structured output. No transcript or never connected → no LLM; report it as is.
- `notify.ts`: SMS formatter + send (never throws, records the real status, sends at most once per call).

### 2. MCP server + CLI
- MCP (stdio): `place_call`, `get_call` (with `outputSchema`). Bonus tools: `list_calls`, `cancel_call`.
- CLI: `call`, `status <id>`, `watch <id>` (live transcript), `history`.
- Register with Claude Code via `.mcp.json` and run the example request end to end.

### 3. Test + iterate (the core of the exercise)
- Unit tests: idempotency (sequential + concurrent), status mapping, SMS formatting, outcome
  shortcuts for no-answer and failed calls.
- Transcript fixtures for the outcome extractor: happy path, **only 8 pm available**, deposit required,
  no outdoor seating, voicemail, hang-up mid-call, a counter-offer under a different name.
- Live scripted calls with me acting as the restaurant. Log each run and each change in `NOTES.md`
  (what we saw, what we changed, why).

### 4. Experience improvements (bonus, in priority order)
1. **Preflight**: before dialing, check the task for missing essentials (date, party size, name, time
   window) and return `needs_info` with questions instead of calling.
2. Voice prompt: discloses that it's an AI assistant, asks one thing at a time, reads back
   confirmation details, never agrees outside the constraints, handles hold, IVR and voicemail.
3. Live transcript (`watch`) and call history.
4. A small local web page for call history and outcomes, if time allows.

### 5. Docs
README (setup, demo script, architecture), NOTES.md (iteration log), and "with more time" ideas.
