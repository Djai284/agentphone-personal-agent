// The call lifecycle: place (validate → idempotency → dial), refresh (poll → finalize → notify).
// Every step is safe to run from several processes at once and safe to repeat after a crash.
import { createHash } from "node:crypto";
import { AgentPhone, AgentPhoneError, type ProviderCall } from "./agentphone.ts";
import type { Config } from "./config.ts";
import { formatResultSms } from "./notify.ts";
import { OutcomeExtractor } from "./outcome.ts";
import { buildGreeting, buildSystemPrompt } from "./prompt.ts";
import {
  type CallStatus,
  type CallView,
  type PlaceCallInput,
  type PlaceCallRequest,
  PlaceCallInput as PlaceCallInputSchema,
  TERMINAL_STATUSES,
  type TranscriptTurn,
} from "./schemas.ts";
import { type CallRow, Store, toView } from "./store.ts";

/** A call row that was stored but never handed to AgentPhone (e.g. the process died mid-dial). */
const STALE_QUEUED_MS = 60_000;

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

/** Map AgentPhone's call state onto ours. `null` means the call has ended and needs finalizing. */
export function mapProviderStatus(call: ProviderCall): { status: CallStatus; reason: string | null } | { status: null; reason: string | null } {
  const s = call.status.toLowerCase().replace(/_/g, "-");
  const reason = call.failureReason ?? call.disconnectionReason ?? null;
  const why = `${s} ${reason ?? ""}`.toLowerCase();
  if (/no-?answer|no_answer/.test(why)) return { status: "no_answer", reason };
  if (/busy/.test(why)) return { status: "busy", reason };
  if (["failed", "error", "canceled", "cancelled"].includes(s)) return { status: s.startsWith("cancel") ? "canceled" : "failed", reason };
  if (["queued", "initiated", "ringing", "dialing"].includes(s)) return { status: "dialing", reason };
  if (s === "in-progress" && !call.endedAt) return { status: "in_progress", reason };
  // completed, ended, or anything else with an end time: the conversation is over.
  if (s === "completed" || call.endedAt) return { status: null, reason };
  return { status: "in_progress", reason };
}

export class CallService {
  readonly store: Store;
  readonly phone: AgentPhone;
  private readonly extractor: OutcomeExtractor;

  constructor(
    private readonly config: Config,
    deps: { store?: Store; phone?: AgentPhone; extractor?: OutcomeExtractor } = {},
  ) {
    this.store = deps.store ?? new Store(config.BOOKING_DB);
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

  /** Return the existing call for this key, or throw if the key was used for a different request. */
  existing(input: PlaceCallInput): CallView | null {
    const row = this.store.getByKey(input.idempotency_key);
    if (!row) return null;
    if (row.request_hash !== requestHash(input)) {
      throw new IdempotencyConflict(
        `Idempotency key "${input.idempotency_key}" was already used for a different request (call ${row.id}). Use a new key for a new call.`,
      );
    }
    return toView(row);
  }

  async place(input: PlaceCallInput): Promise<PlaceCallResult> {
    const hash = requestHash(input);
    const { row, created } = this.store.createOrGet(input, hash);
    if (!created) {
      const call = this.existing(input)!; // re-checks the hash for the concurrent-insert case
      return { kind: "existing", call };
    }
    await this.dial(row, input);
    return { kind: "placed", call: toView(this.store.get(row.id)!) };
  }

  private async dial(row: CallRow, input: PlaceCallInput): Promise<void> {
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
      this.store.transition(row.id, ["queued"], "dialing", { provider_call_id: created.id, started_at: created.startedAt ?? null });
    } catch (err) {
      // We don't know for sure the call wasn't placed if the request timed out, but AgentPhone has no
      // idempotency key of its own, so retrying would risk a second call. Fail loudly instead.
      const message = err instanceof AgentPhoneError ? err.message : `Dial failed: ${(err as Error).message}`;
      this.store.transition(row.id, ["queued"], "failed", { error: message });
      await this.notify(row.id);
    }
  }

  get(id: string): CallView | null {
    const row = this.store.get(id);
    return row ? toView(row) : null;
  }

  /** Bring a call up to date with AgentPhone, finalizing and notifying if it has ended. */
  async refresh(id: string): Promise<CallView | null> {
    const row = this.store.get(id);
    if (!row) return null;
    const status = row.status as CallStatus;

    if (status === "queued" && Date.now() - Date.parse(row.created_at) > STALE_QUEUED_MS) {
      this.store.transition(id, ["queued"], "failed", { error: "The call was never handed to AgentPhone (the server stopped mid-dial)." });
      await this.notify(id);
    } else if ((status === "dialing" || status === "in_progress") && row.provider_call_id) {
      await this.poll(row);
    }
    if (this.store.get(id)!.status === "analyzing") await this.finalize(id);
    else if (TERMINAL_STATUSES.has(this.store.get(id)!.status as CallStatus)) await this.notify(id);
    return toView(this.store.get(id)!);
  }

  private async poll(row: CallRow): Promise<void> {
    let call: ProviderCall;
    try {
      call = await this.phone.getCall(row.provider_call_id!);
    } catch (err) {
      this.store.event(row.id, "poll_error", (err as Error).message);
      return;
    }
    const mapped = mapProviderStatus(call);
    const fields: Partial<CallRow> = {
      started_at: call.startedAt ?? row.started_at,
      ended_at: call.endedAt ?? null,
      duration_seconds: call.durationSeconds ?? null,
      end_reason: mapped.reason,
    };
    const from: CallStatus[] = ["dialing", "in_progress"];
    if (mapped.status === null) this.store.transition(row.id, from, "analyzing", fields);
    else if (mapped.status !== row.status) this.store.transition(row.id, from, mapped.status, fields);
  }

  /** Fetch the transcript, extract the outcome, and complete the call. Only one process wins the lease. */
  private async finalize(id: string): Promise<void> {
    if (!this.store.claimFinalize(id)) return;
    const row = this.store.get(id)!;
    const input = this.store.request(row);
    let turns: TranscriptTurn[] = [];
    try {
      const t = await this.phone.getTranscript(row.provider_call_id!);
      turns = t.transcript.map((x) => ({ speaker: x.role === "agent" ? "agent" : "other", text: x.content, at: x.createdAt ?? undefined }));
      this.store.update(id, { transcript_json: JSON.stringify(turns) });
      const outcome = await this.extractor.extract(input, turns, row.ended_at ? new Date(row.ended_at) : new Date());
      this.store.transition(id, ["analyzing"], "completed", { outcome_json: JSON.stringify(outcome) });
    } catch (err) {
      // Leave it in 'analyzing'; the lease expires and the reconciler retries.
      this.store.event(id, "finalize_error", (err as Error).message);
      return;
    }
    await this.notify(id);
  }

  /** Text the result to the user, exactly once per call. */
  async notify(id: string): Promise<void> {
    const row = this.store.get(id)!;
    const to = this.store.request(row).notify_phone ?? this.config.USER_PHONE;
    if (!this.store.claimSms(id, to)) return;
    const body = formatResultSms(toView(row));
    try {
      const sent = await this.phone.sendSms(this.config.AGENTPHONE_NUMBER_ID, to, body);
      const failed = ["failed", "undelivered", "rejected", "error"].includes(String(sent.status ?? "").toLowerCase());
      this.store.update(id, {
        sms_status: failed ? "failed" : "sent",
        sms_message_id: sent.id ?? null,
        sms_error: failed ? `AgentPhone reported status '${sent.status}'` : null,
      });
    } catch (err) {
      this.store.update(id, { sms_status: "failed", sms_error: (err as Error).message });
    }
    this.store.event(id, "sms", this.store.get(id)!.sms_status);
  }

  async cancel(id: string): Promise<CallView | null> {
    const row = this.store.get(id);
    if (!row) return null;
    if (row.provider_call_id && ["dialing", "in_progress"].includes(row.status)) {
      await this.phone.endCall(row.provider_call_id).catch((err) => this.store.event(id, "cancel_error", (err as Error).message));
    }
    return this.refresh(id);
  }

  /** Poll every pending call once. Used by the background reconciler. */
  async reconcile(): Promise<void> {
    for (const row of this.store.pending()) await this.refresh(row.id).catch(() => {});
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

  /** Refresh until the call is terminal (for the CLI and tests). */
  async waitForResult(id: string, { intervalMs = 3000, timeoutMs = 15 * 60_000, onUpdate }: { intervalMs?: number; timeoutMs?: number; onUpdate?: (c: CallView) => void } = {}): Promise<CallView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const call = (await this.refresh(id))!;
      onUpdate?.(call);
      if (TERMINAL_STATUSES.has(call.status) && call.sms.status !== "not_sent") return call;
      if (Date.now() > deadline) return call;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
