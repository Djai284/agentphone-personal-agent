// Before dialing: would the agent get stuck on this call? A call is expensive (real people, real
// time) and a missing detail is cheap to ask for, so check the request first.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { todayLine, upcomingDays } from "../calendar.ts";
import type { PlaceCallInput } from "../schemas.ts";

export const PreflightResult = z.object({
  ready: z.boolean().describe("true if the assistant can complete the call without inventing anything."),
  missing: z
    .array(z.object({ detail: z.string(), question: z.string().describe("Question to ask the user, short and specific.") }))
    .describe("Details the other party will almost certainly need that the request doesn't give. Empty when ready."),
  warnings: z
    .array(z.string())
    .describe("Non-blocking issues worth surfacing (ambiguous wording, conflicting constraints, an unusual date). Often empty."),
});
export type PreflightResult = z.infer<typeof PreflightResult>;

const SYSTEM = `An AI assistant is about to phone someone on a user's behalf. Check the request before it dials.

Block (ready = false) only for details the other party will almost certainly ask for and the assistant cannot answer or reasonably leave open. Examples:
- Booking a table: date, time or time window, party size, and a name.
- A medical or service appointment: who it's for, rough availability, and the reason for the visit.
- Anything tied to an account or order: the identifier they'll need to look it up.
Don't block on nice-to-haves, on things the assistant can ask the other party, or on details the user gave in a different form. Relative dates like "this Friday" are fine: the assistant gets a calendar.
Ask at most three questions, each one short.`;

export class Preflight {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async check(req: PlaceCallInput, now = new Date()): Promise<PreflightResult> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(PreflightResult) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `${todayLine(now)} ${upcomingDays(now)}`,
            `Calling: ${req.recipient ?? "(not specified)"}`,
            `On behalf of: ${req.on_behalf_of.name} (the assistant introduces itself for, and books under, this name)`,
            `Other details the assistant may share: ${JSON.stringify(req.on_behalf_of.details)}`,
            `Task: ${req.task}`,
            `Constraints: ${JSON.stringify(req.constraints)}`,
            `Questions to ask: ${JSON.stringify(req.questions)}`,
          ].join("\n"),
        },
      ],
    });
    if (!response.parsed_output) return { ready: true, missing: [], warnings: ["Preflight check was inconclusive."] };
    return response.parsed_output;
  }
}
