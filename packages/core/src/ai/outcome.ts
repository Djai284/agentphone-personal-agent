// Turns a finished call's transcript into a structured Outcome. Claude does the reading, but only
// for calls where a conversation actually happened; unanswered and failed calls are reported
// deterministically so the model never gets a chance to invent a result.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { todayLine } from "../calendar.ts";
import { type Outcome, Outcome as OutcomeSchema, type PlaceCallInput, type TranscriptTurn } from "../schemas.ts";

const SYSTEM = `You review phone calls an AI assistant made on someone's behalf, and report what actually happened.

Rules:
- Rely only on the transcript. A fact is "confirmed" only if the other party stated or agreed to it. What the assistant asked for is not confirmed unless they agreed.
- Be strict about ranges and specifics. If the goal asked for a window (e.g. 6:30–7:30 pm) and no exact value was agreed, the time is unresolved, not confirmed.
- For each constraint: "met" needs evidence from the other party; "violated" if the agreement breaks it; "unknown" if it never came up. An unknown constraint that matters means the result is at best partially_succeeded, and it belongs in unresolved.
- If the other party could only offer something outside the constraints and the assistant (correctly) didn't accept, the result is not_possible and the offers go in alternatives_offered.
- If the assistant accepted something that breaks a constraint, say so plainly in the summary and mark it violated.
- Judge the assistant against the whole request, including "If not possible". When the goal couldn't be met and the assistant carried out that fallback (e.g. cancelling a reservation because the condition wasn't met), it followed instructions: the result is not_possible, the summary says the fallback was done as asked, and what the other party agreed to for the fallback goes in confirmed. Only actions outside both the goal and the fallback count against the assistant.
- Sharing a detail listed under "Details it may share" is expected, not a problem.
- Speech-to-text is imperfect: read through obvious transcription errors, but don't guess at details that are genuinely unclear; list them as unresolved.
- The summary is for the person who asked for the call: one or two plain sentences, lead with the result.
- Write the summary, unresolved items and alternatives in second person, as if texting the person the call was made for: "You're booked for...", "Your Saturday 3:00 pm appointment is unchanged", "You'd need to decide...". Never refer to them by name or in the third person. Evidence quotes can stay as they are.`;

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n") || "(none)";

/**
 * Everything the voice agent was told, in the grader's words. Anything the agent was allowed to do
 * (a fallback, a detail it may share) has to be here, or doing it looks like going off-script.
 */
export function describeRequest(req: PlaceCallInput, endedAt: Date = new Date()): string {
  const details = Object.entries(req.on_behalf_of.details).map(([k, v]) => `${k}: ${v}`);
  return [
    `Call made: ${todayLine(endedAt)}`,
    `Calling: ${req.recipient ?? "unknown"} on behalf of ${req.on_behalf_of.name}`,
    `Goal: ${req.task}`,
    `Constraints:\n${list(req.constraints)}`,
    `Questions to answer:\n${list(req.questions)}`,
    `If not possible: ${req.if_not_possible ?? "don't commit to anything outside the goal; collect the alternatives offered and report back."}`,
    `Details it may share:\n${list(details)}`,
  ].join("\n");
}

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

    const request = describeRequest(req, endedAt);

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
