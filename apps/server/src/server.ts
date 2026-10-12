// HTTP endpoints AgentPhone calls: the agent webhook (texts from the user, call-ended events) and
// the place_call custom tool the voice agent uses when the user phones in.
import {
  CallDraft,
  type CallService,
  type Config,
  draftToRequest,
  Intake,
  isPersonalNumber,
  ROOT,
  TERMINAL_STATUSES,
  type ThreadMessage,
  ToolRequest,
  verifySignature,
  WebhookEvent,
} from "@callagent/core";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { z } from "zod";

/** How long to hold an outgoing call for the user to hang up, if no call-ended event arrives. */
const HANGUP_FALLBACK_MS = 90_000;
/** Pause after the user's call ends before ringing them again. */
const AFTER_HANGUP_MS = 4_000;

/** Keep raw payloads locally (gitignored): the docs leave these shapes unspecified. */
function capture(kind: string, payload: unknown) {
  const dir = `${ROOT}logs/payloads`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}.json`, JSON.stringify(payload, null, 2));
}

export class PhoneServer {
  private readonly intake: Intake;
  private webhookSecret: string | null = null;
  /** Callers whose own line we're waiting on before ringing it, keyed by phone number. */
  private hangupWaiters = new Map<string, (() => void)[]>();
  private readonly log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

  constructor(
    private readonly config: Config,
    private readonly service: CallService,
    private readonly toolSecret: string,
  ) {
    this.intake = new Intake(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
  }

  setWebhookSecret(secret: string | null) {
    this.webhookSecret = secret;
  }

  listen(port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        this.route(req, raw)
          .then(({ status, body }) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body)))
          .catch((err) => {
            this.log(`error on ${req.url}: ${(err as Error).stack}`);
            res.writeHead(500).end("{}");
          });
      });
    });
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }

  private async route(req: http.IncomingMessage, raw: string): Promise<{ status: number; body: unknown }> {
    if (req.method === "GET" && req.url === "/health") return { status: 200, body: { ok: true } };
    if (req.method === "POST" && req.url === "/webhooks/agentphone") return this.onWebhook(req, raw);
    if (req.method === "POST" && req.url === "/tools/place_call") return this.onPlaceCallTool(req, raw);
    return { status: 404, body: {} };
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  private async onWebhook(req: http.IncomingMessage, raw: string) {
    const h = (name: string) => req.headers[name] as string | undefined;
    if (this.webhookSecret && !verifySignature(this.webhookSecret, raw, h("x-webhook-signature"), h("x-webhook-timestamp"))) {
      this.log("webhook rejected: bad signature");
      return { status: 401, body: {} };
    }
    const parsed = WebhookEvent.safeParse(JSON.parse(raw));
    if (!parsed.success) return { status: 200, body: {} };
    const event = parsed.data;
    capture(event.event, event);
    const deliveryId = h("x-webhook-id") ?? createHash("sha256").update(raw).digest("hex");
    if (!(await this.service.repo.claimDelivery(deliveryId, event.event))) return { status: 200, body: {} };

    // Acknowledge now; work in the background so AgentPhone never retries because we were slow.
    void this.handleEvent(event).catch(async (err) => {
      await this.service.repo.releaseDelivery(deliveryId);
      this.log(`failed handling ${event.event}: ${(err as Error).message}`);
    });
    return { status: 200, body: {} };
  }

  private async handleEvent(event: WebhookEvent) {
    if (event.event === "agent.call_ended") return this.onCallEnded(event);
    if (event.event === "agent.message" && event.data.direction === "inbound" && event.channel !== "voice") return this.onText(event);
  }

  private async onCallEnded(event: WebhookEvent) {
    const ours = event.data.callId ? await this.service.repo.getByProviderId(event.data.callId) : null;
    if (ours) {
      this.log(`call ended: ${ours.id}; finalizing`);
      await this.service.refresh(ours.id);
    } else if (event.data.direction === "inbound" && event.data.from) {
      this.log(`${event.data.from}'s call with the agent ended`);
      const waiters = this.hangupWaiters.get(event.data.from) ?? [];
      this.hangupWaiters.delete(event.data.from);
      waiters.forEach((w) => w());
    }
  }

  private async onText(event: WebhookEvent) {
    const from = event.data.from ?? "";
    const text = event.data.message ?? "";
    // Anyone can text the agent, but never reply to short codes or carrier bounce senders: that loops.
    if (!isPersonalNumber(from)) {
      this.log(`ignored text from ${from} (not a personal phone number)`);
      return;
    }
    this.log(`text from ${from}: ${text}`);
    const thread: ThreadMessage[] = (event.recentHistory ?? [])
      .filter((m) => m.content)
      .map((m) => ({ from: m.direction === "inbound" ? "user" : "assistant", text: m.content! }));
    if (thread.at(-1)?.from !== "user" || !thread.at(-1)!.text.endsWith(text)) thread.push({ from: "user", text });

    const recent = await this.service.recentCallsFor(from, 5);
    const decision = await this.intake.decide(thread, recent, from === this.config.USER_PHONE ? this.config.USER_NAME : undefined);
    this.log(`intake: ${decision.action}${decision.call ? ` → ${decision.call.recipient} ${decision.call.to}` : ""}`);

    if (decision.action === "place_call" && decision.call) {
      let input;
      try {
        input = this.service.parse(draftToRequest(decision.call, `sms-${event.data.conversationId ?? "x"}-${Date.now()}`, from));
      } catch (err) {
        const why = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
        return this.reply(from, `I can't place that call: ${why}`);
      }
      await this.reply(from, decision.message);
      const { call } = await this.service.place(input, { source: "sms" });
      if (call.status === "failed") this.log(`dial failed: ${call.error}`); // the failure text goes out via notify()
      return;
    }
    if (decision.action === "cancel_call") {
      const active = recent.find((c) => !TERMINAL_STATUSES.has(c.status));
      if (!active) return this.reply(from, "There's no call in progress right now.");
      await this.service.cancel(active.call_id);
      return this.reply(from, decision.message || `Hung up the call to ${active.recipient ?? active.to}.`);
    }
    return this.reply(from, decision.message);
  }

  private async reply(to: string, body: string) {
    try {
      await this.service.phone.sendSms(this.config.AGENTPHONE_NUMBER_ID, to, body);
      this.log(`texted ${to}: ${body.split("\n")[0]}`);
    } catch (err) {
      this.log(`reply text failed: ${(err as Error).message}`);
    }
  }

  // ── Voice: place_call tool ──────────────────────────────────────────────────

  private async onPlaceCallTool(req: http.IncomingMessage, raw: string) {
    if (req.headers.authorization !== `Bearer ${this.toolSecret}`) return { status: 401, body: { result: "Not authorized." } };
    const body = ToolRequest.parse(JSON.parse(raw));
    capture("tool-place_call", body);
    // Custom tools are attached to the agent, so they're also offered on the calls it places itself.
    // A request from one of those calls is the voice agent confusing its role; refuse it.
    if (body.call?.direction === "outbound") {
      this.log("ignored place_call from an outgoing call");
      return { status: 200, body: { result: "Not available on this call. Carry on with your task; the person you're speaking to can't approve changes." } };
    }
    // The caller is who asked, so they get the result. Fall back to the owner if AgentPhone omits it.
    const caller = body.call?.from_number ?? body.call?.fromNumber ?? this.config.USER_PHONE;
    const draft = CallDraft.safeParse(body.args ?? body.arguments ?? body);
    if (!draft.success) {
      return { status: 200, body: { result: `I'm missing some details: ${z.prettifyError(draft.error)}. Ask the user for them, then try again.` } };
    }
    const key = `voice-${body.call?.call_id ?? createHash("sha256").update(JSON.stringify(draft.data)).digest("hex").slice(0, 16)}`;
    let input;
    try {
      input = this.service.parse(draftToRequest(draft.data, key, caller));
    } catch (err) {
      const why = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
      return { status: 200, body: { result: `That can't be placed: ${why}` } };
    }
    if (await this.service.existing(input)) return { status: 200, body: { result: "That call is already set up. Nothing more to do." } };

    // If they want us to call their own number (e.g. testing with one phone), wait until they hang up.
    const sameLine = input.to === caller;
    this.log(`voice request from ${caller}: call ${input.recipient ?? input.to}${sameLine ? " after they hang up" : ""}`);
    void this.service
      .place(input, { source: "voice", ...(sameLine ? { beforeDial: () => this.waitForHangup(caller) } : {}) })
      .then(({ call }) => this.log(`dialing ${call.recipient ?? call.to} (${call.call_id}): ${call.status}`))
      .catch((err) => this.log(`voice-requested call failed: ${(err as Error).message}`));
    return {
      status: 200,
      body: {
        result: sameLine
          ? `Done. I'll call ${input.recipient ?? "them"} as soon as this call ends, and text the caller the result.`
          : `Done. I'm calling ${input.recipient ?? "them"} now, and will text the caller the result.`,
      },
    };
  }

  /** Resolve once `phone`'s call with the agent has ended, so their line is free to ring. */
  private waitForHangup(phone: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        setTimeout(resolve, AFTER_HANGUP_MS);
      };
      this.hangupWaiters.set(phone, [...(this.hangupWaiters.get(phone) ?? []), finish]);
      setTimeout(() => {
        if (!done) this.log("no call-ended event arrived; dialing anyway");
        finish();
      }, HANGUP_FALLBACK_MS);
    });
  }
}
