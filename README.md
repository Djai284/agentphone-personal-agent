# AgentPhone Personal Agent

Ask an AI assistant to make a phone call for you. It calls, gets the task done within your rules, and
texts you what happened.

> *"Call Bella Napoli at 212-555-0123 and book a table for four this Friday between 6:30 and 7:30 pm, under
> the name Manav. Ask about outdoor seating. Don't accept a reservation that requires a deposit."*

There are three ways to ask, all built on [AgentPhone](https://agentphone.ai):

| Ask from | How |
|---|---|
| **Claude** (Claude Code, Claude Desktop, any MCP client) | `place_call` / `get_call` MCP tools |
| **A text** | Text the agent's number. It asks for anything missing, then calls. |
| **A phone call** | Call the agent's number and tell it what you need. |

Whichever you use, a voice agent makes the call. It reads back what was agreed and never accepts something
you didn't ask for. You get a structured result: what was confirmed, whether each of your rules was met, and
what's still open. The same result is texted to you.

## Prerequisites

| | Why | Get it |
|---|---|---|
| **Node.js 24+** | runs everything | [nodejs.org](https://nodejs.org) or `brew install node` |
| **Docker** | local Postgres | [Docker Desktop](https://www.docker.com/products/docker-desktop/). Or point `DATABASE_URL` at any Postgres. |
| **AgentPhone account** | the phone number, voice agent, and SMS | [agentphone.ai](https://agentphone.ai): an API key and **one phone number with outbound SMS enabled** |
| **Anthropic API key** | understands requests and grades calls | [console.anthropic.com](https://console.anthropic.com) |
| **cloudflared** *(only to text or call the agent)* | lets AgentPhone reach your machine | `brew install cloudflared` |

## Setup

```bash
git clone https://github.com/Djai284/agentphone-personal-agent.git
cd agentphone-personal-agent
npm install
npm run setup
```

`npm run setup` asks for your AgentPhone key, Anthropic key, and mobile number, then:
- checks both keys work
- starts Postgres in Docker and applies migrations
- finds or creates the **Personal Call Agent** on AgentPhone, attaches your SMS-capable number to it, and
  routes the number's calls to it. If the number belongs to another agent, it asks before moving it.
- writes everything to `.env`

It's safe to re-run at any time: it reuses what exists. It ends by printing your agent's number and the exact
MCP config for your machine.

## Use it

### From Claude (MCP)

**Claude Code:** run `claude` in this folder and approve the `personal-call-agent` server (from `.mcp.json`),
then ask:

> Call Bella Napoli at 212-555-0123 and book a table for four this Friday between 6:30 and 7:30 pm, under the
> name Manav. Ask about outdoor seating. Don't accept a reservation that requires a deposit.

Claude places the call, follows it, and reports back, and the result is texted to `USER_PHONE`. If the
request is missing something the other side will ask for (party size, time), it asks you before dialing.

**Claude Desktop or another folder:** `npm run setup` prints the exact config with absolute paths. It looks like:

```json
{ "mcpServers": { "personal-call-agent": {
    "command": "/path/to/agentphone-personal-agent/node_modules/.bin/tsx",
    "args": ["/path/to/agentphone-personal-agent/apps/mcp/src/index.ts"] } } }
```

| Tool | What it does |
|---|---|
| `place_call` | Phone someone to do a task. Takes the destination, task, who it's for, rules, questions, and an idempotency key. Returns a `call_id` right away. |
| `get_call` | Status, transcript, and structured outcome. `wait_seconds` waits for the next change instead of polling. |
| `list_calls` | Call history. |
| `cancel_call` | Hang up a call in progress. |

Reusing an `idempotency_key` returns the original call and never dials twice. Reusing it with a *different*
request is an error.

### By text or phone call

```bash
npm run server
```

This starts a local server, opens a Cloudflare tunnel, and connects the agent to it. Anyone can then text
or call the agent's number:
- **Text** *"Can you book a haircut at Tony's Barbers (212-555-0199) Saturday at 3pm under Sam?"*. It asks
  for anything missing, confirms, calls, and texts the result back in the same thread. Follow-ups like
  *"ok take the 4pm then"* work.
- **Call** the number and say what you need. It recaps, waits for your "yes", and calls after you hang up.
  It waits so the same phone can play both sides in a demo.

Ctrl-C disconnects the agent; callers then hear that the assistant is offline.

> **Heads-up:** while `npm run server` is running, anyone who has the number can make your AgentPhone account
> call any US/Canada number. Set `CALL_ALLOWLIST` in `.env` to restrict destinations.

## Demo script

You can play every role with one phone (set `USER_PHONE` to it and call your own number):

1. **Ask vaguely:** "Book Bella Napoli for Friday." Claude asks how many people and what time before
   dialing.
2. **Ask fully:** the restaurant request above. Your phone rings; play the restaurant and say *"We only have
   8 pm."* The agent doesn't book. The result says the request couldn't be met, with 8 pm as the alternative.
3. **Deposit:** offer 7 pm "with a $20 deposit". It declines.
4. **Happy path:** offer 7:15, say there's no deposit when asked. It reads the booking back and reports
   success.
5. **Idempotency:** ask Claude to repeat the request with the same idempotency key. No second call.
6. **Unanswered:** decline the call. It's reported as no answer, and you get a text saying so.

## How it works

```
 Claude (MCP) ─┐                                         ┌─ AgentPhone hosted voice ─► the business
               ├─► CallService ──► POST /v1/calls ───────┤   (per-call prompt built from your request)
 text / call ──┘   (idempotent)    systemPrompt, greeting └─ transcript ─┐
                        ▲                                                ▼
                    Postgres ◄── poll + call_ended webhook ◄── Claude grades the call → Outcome (zod)
                                                                         │
                                                       result SMS ◄──────┘  (exactly once)
```

- **The voice agent** is AgentPhone's hosted LLM, configured per call from your request
  (`packages/core/src/voice/outbound.ts`). The prompt is task-agnostic, so it works for restaurants, salons,
  doctors, or stores alike. Rules learned from live calls: it's the customer's side, it never approves
  changes on your behalf, it pins down exact times, and it waits for a real "yes".
- **Grading** is a separate Claude pass over the transcript (`packages/core/src/ai/outcome.ts`). Every
  constraint is marked met, violated, or unknown, with a quote as evidence. A call that never connected is
  reported as such without asking the model.
- **Exactly once:** dialing, finalizing, and texting are conditional database updates, so the MCP server
  and the server can run at once (and several Claude windows can share the database) without double calls or
  double texts.
- **Shared types:** zod schemas are the single source of truth for MCP input/output, Claude's structured
  output, and stored rows. Call statuses are defined once in the Prisma schema.

`NOTES.md` is the iteration log: what each live test showed, and what was changed because of it.

## Project layout

```
apps/
  mcp/       MCP server (stdio). Claude starts it; it places calls and reports results.
  server/    The HTTP server AgentPhone calls back into: incoming texts (webhook), the voice agent's
             place_call tool, and call-ended events. `npm run server` exposes it via a tunnel.
packages/
  core/      Everything shared; apps import only from here.
    src/agentphone/   REST client, agent settings, status mapping, webhook/tool payloads
    src/calls/        CallService: place → poll → grade → text, idempotent and exactly-once
    src/ai/           Claude: intake (texts), preflight (missing details), outcome grading
    src/voice/        prompts for calls the agent makes, and for when someone phones it
    src/db/           Prisma client and repository (generated client in src/db/generated)
    src/schemas.ts    zod: requests, outcomes, call views
    prisma/           schema.prisma and migrations
scripts/setup.ts     npm run setup
```

**Why two apps?** `apps/mcp` only makes *outgoing* requests (to AgentPhone), so it runs as Claude's child
process with no public URL. Texts and calls to the agent's number start at AgentPhone, which must reach *us*
over HTTP, so `apps/server` is a separate, always-on process. Both use the same `CallService`.

## Development

```bash
npm test             # unit tests (against the Docker Postgres's test database)
npm run typecheck
npm run db:migrate   # after editing packages/core/prisma/schema.prisma
npm run db:studio    # browse the data
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm run setup` says none of your numbers can send texts | In the AgentPhone dashboard, finish SMS registration for a number (or get one that has it), then re-run. |
| `Bind for 0.0.0.0:5434 failed: port is already allocated` | Something else uses 5434. Change the port in `docker-compose.yml` and set `DATABASE_URL` to match. |
| `npm run server` warns it couldn't reach the tunnel | Usually your Mac caching DNS for the brand-new hostname; AgentPhone can still reach it. Text the number to check. |
| Texts to the agent get no reply | `npm run server` must be running. Its log shows every text and decision. |
| Claude Desktop doesn't show the tools | Use the absolute paths `npm run setup` printed, and restart Claude Desktop. |
