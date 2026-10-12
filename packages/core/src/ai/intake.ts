// Turns a text conversation with the user into a call request. Claude decides whether it has enough
// to dial; if not, it asks one short question back. Same request shape as the place_call MCP tool.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { todayLine, upcomingDays } from "../calendar.ts";
import { CallDraft, type CallView } from "../schemas.ts";

export const IntakeDecision = z.object({
  action: z
    .enum(["place_call", "ask", "cancel_call", "reply"])
    .describe("place_call: everything needed is known. ask: a detail is missing. cancel_call: they want the active call stopped. reply: anything else."),
  message: z.string().describe("The text to send back. Short, friendly, plain text, like a capable assistant texting."),
  call: CallDraft.nullable().describe("Required when action is place_call; otherwise null."),
});
export type IntakeDecision = z.infer<typeof IntakeDecision>;

export interface ThreadMessage {
  from: "user" | "assistant";
  text: string;
}

const SYSTEM = `You are a personal assistant the user texts to make phone calls for them. A separate voice agent places the call; your job is to get a complete request and hand it off.

To place a call you need: who to call AND their phone number, what to accomplish with the specifics the other party will ask for (for a booking: date, time or time window, party size), and the name to use. Constraints and questions are optional; include any the user mentioned.
- If something essential is missing, action = ask: ask for all of the missing pieces in one short text. Never invent a phone number, a time, or a name.
- When you have everything, action = place_call. Put every detail into the call fields, and set message to a one-line confirmation of what you're about to do.
- Follow-ups refer to earlier calls (listed below). E.g. "ok book the 8pm then" means a new call with the earlier request updated as the user says. Only drop a constraint if the user clearly says to.
- If they ask to stop or hang up a call in progress, action = cancel_call.
- Otherwise (thanks, a question about a past call), action = reply, answering from the call history only.
Texts are plain text: no markdown.`;

function describeCall(c: CallView): string {
  const o = c.outcome;
  return [
    `- ${c.created_at.slice(0, 16)} ${c.call_id} to ${c.recipient ?? c.to} (${c.to}): ${c.status}`,
    `  task: ${c.task.replace(/\n/g, " ")}`,
    o ? `  result: ${o.result}. ${o.summary}${o.alternatives_offered.length ? ` Offered: ${o.alternatives_offered.join("; ")}.` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class Intake {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(thread: ThreadMessage[], recentCalls: CallView[], userName?: string, now = new Date()): Promise<IntakeDecision> {
    const context = [
      `${todayLine(now)} ${upcomingDays(now)}`,
      userName ? `The user's name is ${userName} (use it unless they say otherwise).` : "The user's name isn't known; ask what name to use if the call needs one.",
      `Recent calls:\n${recentCalls.map(describeCall).join("\n") || "(none)"}`,
    ].join("\n");
    const messages: Anthropic.MessageParam[] = [];
    for (const m of thread) {
      const role = m.from === "user" ? "user" : "assistant";
      const last = messages.at(-1);
      if (last?.role === role) last.content += `\n${m.text}`;
      else messages.push({ role, content: m.text });
    }
    while (messages[0]?.role === "assistant") messages.shift();

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(IntakeDecision) },
      system: `${SYSTEM}\n\n${context}`,
      messages,
    });
    if (!response.parsed_output) return { action: "reply", message: "Sorry, I didn't catch that. Who should I call, and what for?", call: null };
    return response.parsed_output;
  }
}
