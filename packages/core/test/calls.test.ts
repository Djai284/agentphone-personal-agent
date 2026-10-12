import { describe, expect, it } from "vitest";
import {
  describeRequest,
  deterministicOutcome,
  formatResultSms,
  IdempotencyConflict,
  mapProviderStatus,
  NotAllowed,
  PhoneNumber,
  PlaceCallInput,
  requestHash,
} from "../src/index.ts";
import { config, fakeAgentPhone, fixture, makeService, place, request } from "./helpers.ts";

const ringing = fixture("spike-1/poll-000-ringing.json");
const inProgress = fixture("spike-1/poll-002-in-progress.json");
const completed = fixture("spike-1/90-final.json");

describe("phone numbers", () => {
  it.each([
    ["212-555-0123", "+12125550123"],
    ["(212) 555 0123", "+12125550123"],
    ["+1 212 555 0123", "+12125550123"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("normalizes %s", (raw, e164) => expect(PhoneNumber.parse(raw)).toBe(e164));

  it("rejects junk", () => expect(() => PhoneNumber.parse("call me maybe")).toThrow());
});

describe("request hash", () => {
  it("ignores the key and object key order, but not content", () => {
    const a = PlaceCallInput.parse(request());
    const b = PlaceCallInput.parse({ ...request({ idempotency_key: "other" }), on_behalf_of: { details: {}, name: "Manav" } });
    const c = PlaceCallInput.parse(request({ task: "Book a table for five this Friday" }));
    expect(requestHash(a)).toBe(requestHash(b));
    expect(requestHash(a)).not.toBe(requestHash(c));
  });
});

describe("provider status mapping", () => {
  it("maps the statuses seen in real calls", () => {
    expect(mapProviderStatus(ringing).status).toBe("dialing");
    expect(mapProviderStatus(inProgress).status).toBe("in_progress");
    expect(mapProviderStatus(completed).status).toBe(null); // ended → finalize
  });
  it("maps failure reasons", () => {
    expect(mapProviderStatus({ id: "x", status: "completed", endedAt: "t", failureReason: "dial_no_answer" }).status).toBe("no_answer");
    expect(mapProviderStatus({ id: "x", status: "failed", failureReason: "dial_busy" }).status).toBe("busy");
    expect(mapProviderStatus({ id: "x", status: "no-answer" }).status).toBe("no_answer");
    expect(mapProviderStatus({ id: "x", status: "failed", failureReason: "invalid_destination" }).status).toBe("failed");
  });
});

describe("idempotency", () => {
  it("returns the existing call for a repeated key without dialing again", async () => {
    const { phone, log } = fakeAgentPhone({ calls: [ringing] });
    const { svc } = makeService(phone);
    const first = await place(svc, request());
    const second = await place(svc, request());
    expect(first.kind).toBe("placed");
    expect(second.kind).toBe("existing");
    expect(second.call.call_id).toBe(first.call.call_id);
    expect(log.filter((l) => l.method === "POST" && l.path === "/calls")).toHaveLength(1);
  });

  it("dials once when the same request arrives concurrently from two processes", async () => {
    const a = fakeAgentPhone();
    const b = fakeAgentPhone();
    const one = makeService(a.phone).svc;
    const two = makeService(b.phone).svc;
    const results = await Promise.all([place(one, request()), place(two, request())]);
    const dials = [...a.log, ...b.log].filter((l) => l.method === "POST" && l.path === "/calls");
    expect(dials).toHaveLength(1);
    expect(new Set(results.map((r) => r.call.call_id)).size).toBe(1);
  });

  it("rejects a reused key with a different request", async () => {
    const { phone } = fakeAgentPhone();
    const { svc } = makeService(phone);
    await place(svc, request());
    await expect(svc.existing(svc.parse(request({ task: "Cancel my reservation for Friday" })))).rejects.toThrow(IdempotencyConflict);
  });
});

describe("call lifecycle", () => {
  it("polls to completion, extracts the outcome once, and texts once", async () => {
    const { phone, log } = fakeAgentPhone({ calls: [ringing, inProgress, completed] });
    const { svc, extracted } = makeService(phone);
    const { call } = await place(svc, request());
    expect(call.status).toBe("dialing");
    expect((await svc.refresh(call.call_id))!.status).toBe("dialing");
    expect((await svc.refresh(call.call_id))!.status).toBe("in_progress");
    const done = (await svc.refresh(call.call_id))!;
    expect(done.status).toBe("completed");
    expect(done.outcome?.result).toBe("succeeded");
    expect(done.transcript[1]).toMatchObject({ speaker: "other", text: "Yeah. Right now is a good time. " });
    expect(done.sms).toMatchObject({ status: "sent", to: "+12125550123" });
    await svc.refresh(call.call_id);
    expect(extracted).toHaveLength(1);
    expect(log.filter((l) => l.path === "/messages")).toHaveLength(1);
  });

  it("sends the prompt, greeting and screening info to AgentPhone", async () => {
    const { phone, log } = fakeAgentPhone();
    const { svc } = makeService(phone);
    await place(svc, request());
    const body = log.find((l) => l.path === "/calls")!.body as Record<string, string>;
    expect(body).toMatchObject({ agentId: "agent_1", fromNumberId: "num_1", toNumber: "+12125550123" });
    expect(body.systemPrompt).toContain("Don't accept a reservation that requires a deposit");
    expect(body.systemPrompt).toContain("Is outdoor seating available?");
    expect(body.initialGreeting).toContain("on behalf of Manav");
  });

  it("links the owner's result text to the call in the AgentPhone dashboard", async () => {
    const { phone, log } = fakeAgentPhone({ calls: [completed] });
    const { svc } = makeService(phone);
    const { call } = await place(svc, request());
    const done = (await svc.refresh(call.call_id))!;
    expect(done.dashboard_url).toBe("https://agentphone.ai/calls/cmv4g27uu2huvlfp4y2a0v9lz");
    const sms = log.find((l) => l.path === "/messages")!.body as { body: string };
    expect(sms.body).toContain("Full call: https://agentphone.ai/calls/cmv4g27uu2huvlfp4y2a0v9lz");
  });

  it("leaves the dashboard link out for other requesters, who can't log in to it", async () => {
    const { phone, log } = fakeAgentPhone({ calls: [completed] });
    const { svc } = makeService(phone);
    const { call } = await place(svc, request({ notify_phone: "+13125550188" }));
    await svc.refresh(call.call_id);
    const sms = log.find((l) => l.path === "/messages")!.body as { body: string; to_number: string };
    expect(sms.to_number).toBe("+13125550188");
    expect(sms.body).not.toContain("agentphone.ai/calls");
  });

  it("reports an unanswered call accurately", async () => {
    const noAnswer = { ...completed, status: "completed", durationSeconds: 0, failureReason: "dial_no_answer", transcripts: [] };
    const { phone, log } = fakeAgentPhone({ calls: [noAnswer] });
    const { svc, extracted } = makeService(phone);
    const { call } = await place(svc, request());
    const done = (await svc.refresh(call.call_id))!;
    expect(done.status).toBe("no_answer");
    expect(extracted).toHaveLength(0);
    const sms = log.find((l) => l.path === "/messages")!.body as { body: string };
    expect(sms.body).toContain("No answer from Bella Napoli");
  });

  it("marks a rejected dial as failed and says so by text", async () => {
    const { phone, log } = fakeAgentPhone({ createError: 422 });
    const { svc } = makeService(phone);
    const { call } = await place(svc, request());
    expect(call.status).toBe("failed");
    expect(call.error).toContain("422");
    expect((log.find((l) => l.path === "/messages")!.body as { body: string }).body).toContain("Couldn't complete the call");
  });

  it("records a failed text instead of claiming it was sent", async () => {
    const { phone } = fakeAgentPhone({ calls: [completed], smsError: 400 });
    const { svc } = makeService(phone);
    const { call } = await place(svc, request());
    const done = (await svc.refresh(call.call_id))!;
    expect(done.sms.status).toBe("failed");
    expect(done.sms.error).toContain("400");
  });

  it("refuses numbers outside the allowlist", () => {
    const { phone } = fakeAgentPhone();
    const { svc } = makeService(phone, { config: { ...config, CALL_ALLOWLIST: ["+15550001111"] } });
    expect(() => svc.parse(request())).toThrow(NotAllowed);
  });
});

describe("outcomes", () => {
  it("gives the grader the fallback and shareable details, not just the goal", () => {
    const text = describeRequest(
      PlaceCallInput.parse(
        request({
          on_behalf_of: { name: "Jai", details: { callback: "+12125550100" } },
          if_not_possible: "Cancel the reservation and confirm the cancellation.",
        }),
      ),
    );
    expect(text).toContain("If not possible: Cancel the reservation and confirm the cancellation.");
    expect(text).toContain("callback: +12125550100");
  });

  it("doesn't ask the LLM when nobody spoke", () => {
    const o = deterministicOutcome(PlaceCallInput.parse(request()), [{ speaker: "agent", text: "Hi! I'm an AI assistant…" }]);
    expect(o?.result).toBe("no_answer");
    expect(o?.constraint_checks[0]?.status).toBe("unknown");
  });

  it("labels a carried-out fallback as done, not as a failure", async () => {
    const { phone } = fakeAgentPhone({ calls: [completed] });
    const { svc } = makeService(phone, {
      outcome: {
        result: "fallback_succeeded",
        summary: "Nothing was free from 7 to 8, so as your backup plan you're booked at 6:00 pm.",
        confirmed: [{ item: "Time", value: "Fri Oct 16, 6:00 pm" }],
        constraint_checks: [],
        answers: [],
        alternatives_offered: [],
        unresolved: [],
      },
    });
    const { call } = await place(svc, request());
    const text = formatResultSms((await svc.refresh(call.call_id))!);
    expect(text.split("\n")[0]).toBe("✅ Done (backup plan): Bella Napoli");
  });

  it("formats a readable result text", async () => {
    const { phone } = fakeAgentPhone({ calls: [completed] });
    const { svc } = makeService(phone, {
      outcome: {
        result: "not_possible",
        summary: "They only had 8:00 pm, so nothing was booked.",
        confirmed: [],
        constraint_checks: [{ constraint: "No deposit", status: "unknown", evidence: "Not discussed." }],
        answers: [{ question: "Outdoor seating?", answer: "Yes, on the patio." }],
        alternatives_offered: ["Friday 8:00 pm, party of 4"],
        unresolved: ["Whether 8:00 pm works for you"],
      },
    });
    const { call } = await place(svc, request());
    const text = formatResultSms((await svc.refresh(call.call_id))!);
    expect(text).toMatchInlineSnapshot(`
      "❌ Couldn't do it: Bella Napoli
      They only had 8:00 pm, so nothing was booked.

      Your rules:
      ? No deposit

      Q: Outdoor seating?
      A: Yes, on the patio.

      They offered instead:
      • Friday 8:00 pm, party of 4

      Still open:
      • Whether 8:00 pm works for you"
    `);
  });
});
