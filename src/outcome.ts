// Turns a finished call's transcript into a structured Outcome. Claude does the reading, but only
// for calls where a conversation actually happened; unanswered and failed calls are reported
// deterministically so the model never gets a chance to invent a result.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Outcome, PlaceCallInput, TranscriptTurn } from "./schemas.ts";
import { Outcome as OutcomeSchema } from "./schemas.ts";
import { todayLine } from "./prompt.ts";

const SYSTEM = `You review phone calls an AI assistant made on someone's behalf, and report what actually happened.

Rules:
- Rely only on the transcript. A fact is "confirmed" only if the other party stated or agreed to it. What the assistant asked for is not confirmed unless they agreed.
- Be strict about ranges and specifics. If the goal asked for a window (e.g. 6:30–7:30 pm) and no exact value was agreed, the time is unresolved, not confirmed.
- For each constraint: "met" needs evidence from the other party; "violated" if the agreement breaks it; "unknown" if it never came up. An unknown constraint that matters means the result is at best partially_succeeded, and it belongs in unresolved.
- If the other party could only offer something outside the constraints and the assistant (correctly) didn't accept, the result is not_possible and the offers go in alternatives_offered.
- If the assistant accepted something that breaks a constraint, say so plainly in the summary and mark it violated.
- Speech-to-text is imperfect: read through obvious transcription errors, but don't guess at details that are genuinely unclear; list them as unresolved.
- The summary is for the person who asked for the call: one or two plain sentences, lead with the result.`;

function formatTranscript(turns: TranscriptTurn[]): string {
  return turns.map((t) => `${t.speaker === "agent" ? "ASSISTANT" : "OTHER PARTY"}: ${t.text.trim()}`).join("\n");
}

/** Outcomes that need no LLM: the call never turned into a conversation. */
export function deterministicOutcome(req: PlaceCallInput, turns: TranscriptTurn[]): Outcome | null {
  const theySpoke = turns.some((t) => t.speaker === "other" && t.text.trim().length > 0);
  if (theySpoke) return null;
  return {
    result: "no_answer",
    summary: `The call connected but nobody spoke, so nothing was done${req.recipient ? ` with ${req.recipient}` : ""}.`,
    confirmed: [],
    constraint_checks: req.constraints.map((constraint) => ({ constraint, status: "unknown", evidence: "No conversation took place." })),
    answers: req.questions.map((question) => ({ question, answer: "Not asked" })),
    alternatives_offered: [],
    unresolved: [req.task],
  };
}

export class OutcomeExtractor {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(req: PlaceCallInput, turns: TranscriptTurn[], endedAt: Date = new Date()): Promise<Outcome> {
    const shortcut = deterministicOutcome(req, turns);
    if (shortcut) return shortcut;

    const request = [
      `Call made: ${todayLine(endedAt)}`,
      `Calling: ${req.recipient ?? "unknown"} on behalf of ${req.on_behalf_of.name}`,
      `Goal: ${req.task}`,
      `Constraints:\n${req.constraints.map((c) => `- ${c}`).join("\n") || "(none)"}`,
      `Questions to answer:\n${req.questions.map((q) => `- ${q}`).join("\n") || "(none)"}`,
    ].join("\n");

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(OutcomeSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `<request>\n${request}\n</request>\n\n<transcript>\n${formatTranscript(turns)}\n</transcript>`,
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new Error(`Outcome extraction returned no result (stop_reason: ${response.stop_reason})`);
    }
    return response.parsed_output;
  }
}
