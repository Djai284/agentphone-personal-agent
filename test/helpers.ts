import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPhone } from "../src/agentphone.ts";
import { CallService } from "../src/calls.ts";
import type { Config } from "../src/config.ts";
import type { OutcomeExtractor } from "../src/outcome.ts";
import type { Outcome, PlaceCallRequest } from "../src/schemas.ts";
import { Store } from "../src/store.ts";

export const fixture = (path: string) => JSON.parse(readFileSync(new URL(`fixtures/${path}`, import.meta.url), "utf8"));

export const config: Config = {
  AGENTPHONE_API_KEY: "test",
  AGENTPHONE_AGENT_ID: "agent_1",
  AGENTPHONE_NUMBER_ID: "num_1",
  ANTHROPIC_API_KEY: "test",
  USER_PHONE: "+18609779673",
  CALL_ALLOWLIST: [],
  BOOKING_DB: ":memory:",
  ANTHROPIC_MODEL: "test-model",
  AGENTPHONE_MODEL_TIER: "balanced",
};

export const request = (over: Partial<PlaceCallRequest> = {}): PlaceCallRequest => ({
  to: "(860) 977-9673",
  recipient: "Bella Napoli",
  task: "Book a table for four this Friday between 6:30 and 7:30 pm",
  on_behalf_of: { name: "Manav" },
  constraints: ["Don't accept a reservation that requires a deposit"],
  questions: ["Is outdoor seating available?"],
  idempotency_key: "key-1",
  ...over,
});

/** A scripted AgentPhone: `calls` is the sequence of GET /calls/{id} responses. */
export function fakeAgentPhone(opts: { calls?: unknown[]; transcript?: unknown; createError?: number; smsError?: number } = {}) {
  const log: { method: string; path: string; body: unknown }[] = [];
  const calls = [...(opts.calls ?? [])];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.agentphone.ai/v1", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    log.push({ method, path, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    // Let concurrent callers interleave, like a real network round trip.
    await new Promise((r) => setTimeout(r, 5));
    if (method === "POST" && path === "/calls") {
      return opts.createError ? json(opts.createError, { detail: "nope" }) : json(200, fixture("spike-1/01-create.json").body);
    }
    if (method === "GET" && path.endsWith("/transcript")) return json(200, opts.transcript ?? fixture("spike-1/91-transcript.json").body);
    if (method === "GET" && path.startsWith("/calls/")) return json(200, calls.length > 1 ? calls.shift() : calls[0]);
    if (method === "POST" && path === "/messages") return opts.smsError ? json(opts.smsError, { detail: "sms failed" }) : json(200, { id: "msg_1", status: "sent" });
    return json(404, { detail: "not found" });
  }) as typeof fetch;
  return { phone: new AgentPhone("test", fetchImpl), log };
}

export const fakeOutcome: Outcome = {
  result: "succeeded",
  summary: "Booked for four on Friday at 7:00 pm, indoors.",
  confirmed: [{ item: "Time", value: "Fri Oct 16, 7:00 pm" }],
  constraint_checks: [{ constraint: "Don't accept a reservation that requires a deposit", status: "met", evidence: "No deposit needed." }],
  answers: [{ question: "Is outdoor seating available?", answer: "No, because of rain." }],
  alternatives_offered: [],
  unresolved: [],
};

export function makeService(phone: AgentPhone, opts: { dbPath?: string; outcome?: Outcome } = {}) {
  const extracted: unknown[] = [];
  const extractor = {
    extract: async (_req: unknown, turns: unknown) => {
      extracted.push(turns);
      return opts.outcome ?? fakeOutcome;
    },
  } as unknown as OutcomeExtractor;
  const store = new Store(opts.dbPath ?? ":memory:");
  return { svc: new CallService(config, { store, phone, extractor }), extracted };
}

export const tempDb = () => join(mkdtempSync(join(tmpdir(), "callagent-")), "calls.db");
