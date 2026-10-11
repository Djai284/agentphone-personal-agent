// Typed AgentPhone REST client. Response schemas are built from real payloads captured in
// test/fixtures (the public docs leave most of them untyped), and stay permissive (.loose())
// about extra fields so a provider addition never breaks a call in flight.
import { z } from "zod";

const API = "https://api.agentphone.ai/v1";

export const ProviderCall = z
  .object({
    id: z.string(),
    status: z.string(), // seen: ringing, in-progress, completed. Others mapped defensively.
    startedAt: z.string().nullish(),
    endedAt: z.string().nullish(),
    durationSeconds: z.number().nullish(),
    failureReason: z.string().nullish(),
    disconnectionReason: z.string().nullish(),
  })
  .loose();
export type ProviderCall = z.infer<typeof ProviderCall>;

export const ProviderTranscript = z
  .object({
    callId: z.string(),
    status: z.string(),
    transcript: z.array(z.object({ role: z.string(), content: z.string(), createdAt: z.string().nullish() })),
  })
  .loose();
export type ProviderTranscript = z.infer<typeof ProviderTranscript>;

export const StreamEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("connected"), data: z.unknown() }),
  z.object({ event: z.literal("turn"), data: z.object({ role: z.string(), content: z.string(), createdAt: z.string().nullish() }).loose() }),
  z.object({ event: z.literal("ended"), data: z.object({ status: z.string().nullish(), durationSeconds: z.number().nullish() }).loose() }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;

const SentMessage =z.object({ id: z.string().nullish(), status: z.string().nullish() }).loose();

export class AgentPhoneError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(message);
  }
  /** 4xx (other than 408/429) means retrying the same request won't help. */
  get permanent(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500 && ![408, 429].includes(this.status);
  }
}

export interface CreateCallParams {
  agentId: string;
  fromNumberId: string;
  toNumber: string;
  systemPrompt: string;
  initialGreeting: string;
  voice?: string;
  modelTier?: "turbo" | "balanced" | "max" | "realtime";
  callScreeningIdentity?: string;
  callScreeningPurpose?: string;
}

export class AgentPhone {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new AgentPhoneError(`Couldn't reach AgentPhone: ${(err as Error).message}`, null, null);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const detail = typeof json === "object" && json && "detail" in json ? JSON.stringify(json.detail) : text;
      throw new AgentPhoneError(`AgentPhone ${method} ${path} returned ${res.status}: ${detail}`, res.status, json);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AgentPhoneError(`Unexpected AgentPhone response for ${method} ${path}: ${parsed.error.message}`, res.status, json);
    }
    return parsed.data;
  }

  createCall(params: CreateCallParams): Promise<ProviderCall> {
    return this.request(ProviderCall, "POST", "/calls", params);
  }

  getCall(id: string): Promise<ProviderCall> {
    return this.request(ProviderCall, "GET", `/calls/${id}`);
  }

  getTranscript(id: string): Promise<ProviderTranscript> {
    return this.request(ProviderTranscript, "GET", `/calls/${id}/transcript`);
  }

  endCall(id: string): Promise<unknown> {
    return this.request(z.unknown(), "POST", `/calls/${id}/end`);
  }

  /**
   * Live transcript over Server-Sent Events. Replays earlier turns on connect, then yields new turns
   * until the call ends. (GET /calls/{id} only has the transcript after the call is over.)
   */
  async *streamTranscript(id: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.fetchImpl(`${API}/calls/${id}/transcript/stream`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new AgentPhoneError(`Transcript stream returned ${res.status}`, res.status, null);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue; // heartbeat comment
        const parsed = StreamEvent.safeParse({ event, data: JSON.parse(data) });
        if (!parsed.success) continue;
        yield parsed.data;
        if (parsed.data.event === "ended") return;
      }
    }
  }

  sendSms(numberId: string, to: string, body: string) {
    return this.request(SentMessage, "POST", "/messages", { number_id: numberId, to_number: to, body });
  }
}
