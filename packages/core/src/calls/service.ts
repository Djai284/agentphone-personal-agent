// The call lifecycle: place (validate → idempotency → dial), refresh (poll → finalize → notify).
// Every step is safe to run from several processes at once and safe to repeat after a crash.
import { createHash } from "node:crypto";
import { type Call, CallRepository, createDb } from "@callagent/db";
import { AgentPhone, AgentPhoneError, type ProviderCall } from "../agentphone/client.ts";
import { mapProviderStatus } from "../agentphone/status.ts";
import { OutcomeExtractor } from "../ai/outcome.ts";
import type { Config } from "../config.ts";
import { formatResultSms } from "../notify.ts";
import {
  type CallSource,
  type CallStatus,
  type CallView,
  type PlaceCallInput,
  type PlaceCallRequest,
  PlaceCallInput as PlaceCallInputSchema,
  TERMINAL_STATUSES,
  type TranscriptTurn,
} from "../schemas.ts";
import { buildGreeting, buildSystemPrompt } from "../voice/outbound.ts";
import { requestOf, toView } from "./view.ts";

/**
 * A call row that was stored but never handed to AgentPhone (e.g. the process died mid-dial).
 * Generous, because a call requested by voice waits for that conversation to end before dialing.
 */
const STALE_QUEUED_MS = 5 * 60_000;

export class IdempotencyConflict extends Error {}
export class NotAllowed extends Error {}

export type PlaceCallResult = { kind: "placed" | "existing"; call: CallView };

/** Stable hash of everything that defines the request, so a reused key with a different request is caught. */
export function requestHash(input: PlaceCallInput): string {
  const { idempotency_key: _key, skip_preflight: _skip, ...rest } = input;
  const canonical = JSON.stringify(rest, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

const date = (s: string | null | undefined) => (s ? new Date(s) : null);

export class CallService {
  readonly repo: CallRepository;
  readonly phone: AgentPhone;
  private readonly extractor: OutcomeExtractor;

  constructor(
    private readonly config: Config,
    deps: { repo?: CallRepository; phone?: AgentPhone; extractor?: OutcomeExtractor } = {},
  ) {
    this.repo = deps.repo ?? new CallRepository(createDb(config.DATABASE_URL));
    this.phone = deps.phone ?? new AgentPhone(config.AGENTPHONE_API_KEY);
    this.extractor = deps.extractor ?? new OutcomeExtractor(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
  }

  parse(raw: PlaceCallRequest): PlaceCallInput {
    const input = PlaceCallInputSchema.parse(raw);
    const allow = this.config.CALL_ALLOWLIST;
    if (allow.length && !allow.includes(input.to)) {
      throw new NotAllowed(`${input.to} isn't in CALL_ALLOWLIST. Add it to .env to allow calls to it.`);
    }
    return input;
  }

  /** Who gets the result: whoever asked by text or voice, or the owner for MCP and CLI requests. */
  requesterFor(input: PlaceCallInput): string {
    return input.notify_phone ?? this.config.USER_PHONE;
  }

  /** Return the existing call for this key, or throw if the key was used for a different request. */
  async existing(input: PlaceCallInput): Promise<CallView | null> {
    const row = await this.repo.getByKey(input.idempotency_key);
    if (!row) return null;
    if (row.requestHash !== requestHash(input)) {
      throw new IdempotencyConflict(
        `Idempotency key "${input.idempotency_key}" was already used for a different request (call ${row.id}). Use a new key for a new call.`,
      );
    }
    return toView(row);
  }

  /**
   * Store the request and dial. `beforeDial` lets a caller hold the dial (still stored as 'queued'),
   * e.g. until the requester's own call with the agent has ended so their line is free.
   */
  async place(input: PlaceCallInput, opts: { source: CallSource; beforeDial?: () => Promise<void> }): Promise<PlaceCallResult> {
    const { call, created } = await this.repo.createOrGet({
      idempotencyKey: input.idempotency_key,
      requestHash: requestHash(input),
      request: input,
      source: opts.source,
      requester: this.requesterFor(input),
      toNumber: input.to,
      recipient: input.recipient ?? null,
      task: input.task,
    });
    if (!created) return { kind: "existing", call: (await this.existing(input))! }; // re-checks the hash
    if (opts.beforeDial) {
      await this.repo.event(call.id, "waiting", "holding the dial until the line is free");
      await opts.beforeDial();
    }
    await this.dial(call, input);
    return { kind: "placed", call: toView((await this.repo.get(call.id))!) };
  }

  private async dial(row: Call, input: PlaceCallInput): Promise<void> {
    try {
      const created = await this.phone.createCall({
        agentId: this.config.AGENTPHONE_AGENT_ID,
        fromNumberId: this.config.AGENTPHONE_NUMBER_ID,
        toNumber: input.to,
        systemPrompt: buildSystemPrompt(input),
        initialGreeting: buildGreeting(input),
        modelTier: this.config.AGENTPHONE_MODEL_TIER,
        callScreeningIdentity: `${input.on_behalf_of.name}'s assistant`,
        callScreeningPurpose: input.task.slice(0, 200),
        ...(this.config.AGENTPHONE_VOICE ? { voice: this.config.AGENTPHONE_VOICE } : {}),
      });
      await this.repo.transition(row.id, ["queued"], "dialing", { providerCallId: created.id, startedAt: date(created.startedAt) });
    } catch (err) {
      // We don't know for sure the call wasn't placed if the request timed out, but AgentPhone has no
      // idempotency key of its own, so retrying would risk a second call. Fail loudly instead.
      const message = err instanceof AgentPhoneError ? err.message : `Dial failed: ${(err as Error).message}`;
      await this.repo.transition(row.id, ["queued"], "failed", { error: message });
      await this.notify(row.id);
    }
  }

  async get(id: string): Promise<CallView | null> {
    const row = await this.repo.get(id);
    return row ? toView(row) : null;
  }

  /** A requester's own recent calls, so one person's history never shows up in another's thread. */
  async recentCallsFor(requester: string, limit: number): Promise<CallView[]> {
    return (await this.repo.list({ requester, limit })).map(toView);
  }

  async list(limit: number): Promise<CallView[]> {
    return (await this.repo.list({ limit })).map(toView);
  }

  /** Bring a call up to date with AgentPhone, finalizing and notifying if it has ended. */
  async refresh(id: string): Promise<CallView | null> {
    const row = await this.repo.get(id);
    if (!row) return null;

    if (row.status === "queued" && Date.now() - row.createdAt.getTime() > STALE_QUEUED_MS) {
      await this.repo.transition(id, ["queued"], "failed", { error: "The call was never handed to AgentPhone (the server stopped mid-dial)." });
      await this.notify(id);
    } else if ((row.status === "dialing" || row.status === "in_progress") && row.providerCallId) {
      await this.poll(row);
    }
    const status = (await this.repo.get(id))!.status;
    if (status === "analyzing") await this.finalize(id);
    else if (TERMINAL_STATUSES.has(status)) await this.notify(id);
    return toView((await this.repo.get(id))!);
  }

  private async poll(row: Call): Promise<void> {
    let call: ProviderCall;
    try {
      call = await this.phone.getCall(row.providerCallId!);
    } catch (err) {
      await this.repo.event(row.id, "poll_error", (err as Error).message);
      return;
    }
    const mapped = mapProviderStatus(call);
    const fields = {
      startedAt: date(call.startedAt) ?? row.startedAt,
      endedAt: date(call.endedAt),
      durationSeconds: call.durationSeconds ?? null,
      endReason: mapped.reason,
    };
    const from: CallStatus[] = ["dialing", "in_progress"];
    if (mapped.status === null) await this.repo.transition(row.id, from, "analyzing", fields);
    else if (mapped.status !== row.status) await this.repo.transition(row.id, from, mapped.status, fields);
  }

  /** Fetch the transcript, extract the outcome, and complete the call. Only one process wins the lease. */
  private async finalize(id: string): Promise<void> {
    if (!(await this.repo.claimFinalize(id))) return;
    const row = (await this.repo.get(id))!;
    try {
      const t = await this.phone.getTranscript(row.providerCallId!);
      const turns: TranscriptTurn[] = t.transcript.map((x) => ({
        speaker: x.role === "agent" ? "agent" : "other",
        text: x.content,
        ...(x.createdAt ? { at: x.createdAt } : {}),
      }));
      await this.repo.update(id, { transcript: turns });
      const outcome = await this.extractor.extract(requestOf(row), turns, row.endedAt ?? new Date());
      await this.repo.transition(id, ["analyzing"], "completed", { outcome });
    } catch (err) {
      // Leave it in 'analyzing'; the lease expires and the reconciler retries.
      await this.repo.event(id, "finalize_error", (err as Error).message);
      return;
    }
    await this.notify(id);
  }

  /** Text the result to whoever asked, exactly once per call. */
  async notify(id: string): Promise<void> {
    const row = (await this.repo.get(id))!;
    if (!(await this.repo.claimSms(id, row.requester))) return;
    const body = formatResultSms(toView(row));
    try {
      const sent = await this.phone.sendSms(this.config.AGENTPHONE_NUMBER_ID, row.requester, body);
      const failed = ["failed", "undelivered", "rejected", "error"].includes(String(sent.status ?? "").toLowerCase());
      await this.repo.update(id, {
        smsStatus: failed ? "failed" : "sent",
        smsMessageId: sent.id ?? null,
        smsError: failed ? `AgentPhone reported status '${sent.status}'` : null,
      });
      await this.repo.event(id, "sms", failed ? "failed" : "sent");
    } catch (err) {
      await this.repo.update(id, { smsStatus: "failed", smsError: (err as Error).message });
      await this.repo.event(id, "sms", `failed: ${(err as Error).message}`);
    }
  }

  async cancel(id: string): Promise<CallView | null> {
    const row = await this.repo.get(id);
    if (!row) return null;
    if (row.providerCallId && (row.status === "dialing" || row.status === "in_progress")) {
      await this.phone.endCall(row.providerCallId).catch((err) => this.repo.event(id, "cancel_error", (err as Error).message));
    }
    return this.refresh(id);
  }

  /** Poll every pending call once. Used by the background reconciler. */
  async reconcile(): Promise<void> {
    for (const row of await this.repo.pending()) await this.refresh(row.id).catch(() => {});
  }

  /** Keep pending calls moving in the background. Returns a stop function. */
  startReconciler(intervalMs = 3000): () => void {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await this.reconcile();
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Refresh until the call is terminal and its text is out (for the CLI and tests). */
  async waitForResult(
    id: string,
    { intervalMs = 3000, timeoutMs = 15 * 60_000, onUpdate }: { intervalMs?: number; timeoutMs?: number; onUpdate?: (c: CallView) => void } = {},
  ): Promise<CallView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const call = (await this.refresh(id))!;
      onUpdate?.(call);
      if ((TERMINAL_STATUSES.has(call.status) && call.sms.status !== "not_sent") || Date.now() > deadline) return call;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
