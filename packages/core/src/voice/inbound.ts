// Configuration for when the user phones the agent: the hosted agent's own prompt (outbound calls
// override it per call) and the place_call custom tool it uses to hand a request to our server.
import { z } from "zod";
import { todayLine, upcomingDays } from "../calendar.ts";
import { CallDraft } from "../schemas.ts";

export function inboundSystemPrompt(now = new Date()): string {
  return `You are a personal phone assistant. The person calling you wants you to phone someone on their behalf: a restaurant, a doctor's office, a store, anyone. You'll make that call for them and text them the result.
${todayLine(now)} ${upcomingDays(now)}

Collect, one question at a time:
1. Who to call, and their phone number. Read the number back digit by digit to confirm it.
2. What to get done, with the specifics the other side will ask for (for a booking: date, time or time window, party size).
3. The name to give (the caller's name, unless they say otherwise).
4. Any rules (e.g. "no deposit") and anything they want you to ask about.
Don't ask for things they've already told you. Don't invent anything.

When you have it all, recap it in one sentence and ask "Shall I go ahead?". Then stop and wait for their answer. Only a clear yes counts; if they change anything, recap again.
After the yes, call the place_call tool and tell them what it said. Then say a short goodbye and end the call.
If the tool reports a problem, tell them plainly.

Phone style: short sentences, friendly, natural, one question at a time. Say dates like "Friday, October sixteenth".`;
}

export const INBOUND_GREETING = "Hey! Who would you like me to call for you?";

/**
 * AgentPhone customTools entry pointing at our server. AgentPhone rejects a `$schema` key in
 * `parameters` (with a misleading VALIDATION_ERROR_SYSTEMPROMPT), so it's stripped.
 */
export function placeCallTool(publicUrl: string, secret: string) {
  const { $schema: _, ...parameters } = z.toJSONSchema(CallDraft);
  return {
    name: "place_call",
    description:
      "ONLY for incoming calls, where the caller has asked you to phone someone for them: hands their confirmed request " +
      "to the calling system. Never use it on a call you placed yourself. Call it only after the caller says yes to your recap.",
    url: `${publicUrl.replace(/\/$/, "")}/tools/place_call`,
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    parameters,
    timeoutMs: 20_000,
    speakDuringExecution: true,
    executionMessage: "Okay, setting that up.",
  };
}
