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

export const Agent = z
  .object({ id: z.string(), name: z.string(), voiceMode: z.string().nullish(), numbers: z.array(z.object({ id: z.string(), phoneNumber: z.string() }).loose()).nullish() })
  .loose();
export type Agent = z.infer<typeof Agent>;

export const PhoneNumberInfo = z
  .object({
    id: z.string(),
    phoneNumber: z.string(),
    agentId: z.string().nullish(),
    outboundSms: z.string().nullish(), // "enabled" when the number can send texts
    voiceRouting: z.object({ method: z.string() }).loose().nullish(),
  })
  .loose();
export type PhoneNumberInfo = z.infer<typeof PhoneNumberInfo>;

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

  listAgents() {
    return this.request(z.object({ data: z.array(Agent) }).loose(), "GET", "/agents");
  }

  createAgent(settings: Record<string, unknown>) {
    return this.request(Agent, "POST", "/agents", settings);
  }

  listNumbers() {
    return this.request(z.object({ data: z.array(PhoneNumberInfo) }).loose(), "GET", "/numbers");
  }

  /** Move a number to an agent (it leaves whichever agent had it). */
  attachNumber(agentId: string, numberId: string): Promise<unknown> {
    return this.request(z.unknown(), "POST", `/agents/${agentId}/numbers`, { numberId });
  }

  /** Route the number's incoming calls to its agent (rather than a SIP trunk). */
  routeVoiceToAgent(numberId: string): Promise<unknown> {
    return this.request(z.unknown(), "PATCH", `/numbers/${numberId}/voice-routing`, { method: "agent" });
  }

  updateAgent(agentId: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.request(z.unknown(), "PATCH", `/agents/${agentId}`, fields);
  }

  /** Point the agent's events (texts, call ended) at `url`. Returns the signing secret, new on every call. */
  setAgentWebhook(agentId: string, url: string) {
    return this.request(z.object({ id: z.string(), url: z.string(), secret: z.string().nullish() }).loose(), "POST", `/agents/${agentId}/webhook`, {
      url,
      contextLimit: 10,
      timeout: 30,
    });
  }

  sendSms(numberId: string, to: string, body: string) {
    return this.request(SentMessage, "POST", "/messages", { number_id: numberId, to_number: to, body });
  }
}
