import { CallRepository, createDb, type PrismaClient } from "@callagent/db";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach } from "vitest";
import { AgentPhone, CallService, type Config, type Outcome, type OutcomeExtractor, type PlaceCallRequest } from "../src/index.ts";

export const fixture = (path: string) => JSON.parse(readFileSync(new URL(`fixtures/${path}`, import.meta.url), "utf8"));

export const config: Config = {
  AGENTPHONE_API_KEY: "test",
  AGENTPHONE_AGENT_ID: "agent_1",
  AGENTPHONE_NUMBER_ID: "num_1",
  ANTHROPIC_API_KEY: "test",
  USER_PHONE: "+12125550123",
  CALL_ALLOWLIST: [],
  DATABASE_URL: process.env.DATABASE_URL!,
  ANTHROPIC_MODEL: "test-model",
  AGENTPHONE_MODEL_TIER: "balanced",
  PORT: 0,
};

export const request = (over: Partial<PlaceCallRequest> = {}): PlaceCallRequest => ({
  to: "(212) 555-0123",
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

// Every test starts from empty tables. Each service gets its own connection pool, like a separate process.
const clients: PrismaClient[] = [];
const newDb = () => {
  const db = createDb(process.env.DATABASE_URL!);
  clients.push(db);
  return db;
};
beforeEach(async () => {
  await newDb().$executeRawUnsafe("TRUNCATE calls, call_events, webhook_deliveries RESTART IDENTITY CASCADE");
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
});

export function makeService(phone: AgentPhone, opts: { outcome?: Outcome; config?: Config } = {}) {
  const extracted: unknown[] = [];
  const extractor = {
    extract: async (_req: unknown, turns: unknown) => {
      extracted.push(turns);
      return opts.outcome ?? fakeOutcome;
    },
  } as unknown as OutcomeExtractor;
  const svc = new CallService(opts.config ?? config, { repo: new CallRepository(newDb()), phone, extractor });
  return { svc, extracted };
}

/** Parse and place a request the way the MCP server does. */
export const place = (svc: CallService, raw: PlaceCallRequest) => svc.place(svc.parse(raw), { source: "mcp" });
