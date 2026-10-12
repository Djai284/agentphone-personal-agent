// What AgentPhone sends us: signed webhook events (texts, call ended) and custom tool requests.
// Schemas follow captured payloads and stay permissive about extra fields.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WebhookEvent = z
  .object({
    event: z.string(),
    channel: z.string().nullish(),
    data: z
      .object({
        callId: z.string().nullish(),
        conversationId: z.string().nullish(),
        from: z.string().nullish(),
        to: z.string().nullish(),
        message: z.string().nullish(),
        direction: z.string().nullish(),
      })
      .loose(),
    recentHistory: z.array(z.object({ content: z.string().nullish(), direction: z.string().nullish() }).loose()).nullish(),
  })
  .loose();
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** Retell-style tool request: { call: {...}, name, args }. Some setups send the args at the root. */
export const ToolRequest = z
  .object({
    args: z.unknown().optional(),
    arguments: z.unknown().optional(),
    call: z
      .object({ call_id: z.string().nullish(), from_number: z.string().nullish(), fromNumber: z.string().nullish(), direction: z.string().nullish() })
      .loose()
      .nullish(),
  })
  .loose();
export type ToolRequest = z.infer<typeof ToolRequest>;

/** A real person's number: NANP with valid area/exchange codes, or a plausible international number. */
export function isPersonalNumber(n: string): boolean {
  if (n.startsWith("+1")) return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(n);
  return /^\+[2-9]\d{7,14}$/.test(n);
}

export function verifySignature(secret: string, raw: string, signature?: string, timestamp?: string): boolean {
  if (!signature || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
