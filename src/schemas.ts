// Domain types. Each zod schema is the single source of truth for one shape: MCP tool input/output,
// LLM structured output, stored rows, and CLI rendering all derive from these.
import { z } from "zod";

/** Accepts common US formats ("860-977-9673", "(860) 977 9673", "+1 860…") and normalizes to E.164. */
export const PhoneNumber = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const digits = raw.replace(/[^\d+]/g, "");
    const e164 = digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      ctx.addIssue({ code: "custom", message: `"${raw}" is not a valid phone number` });
      return z.NEVER;
    }
    return e164;
  })
  .describe("Phone number. US numbers may omit +1; others need the country code.");

export const PlaceCallInput = z.object({
  to: PhoneNumber.describe("Number to call."),
  recipient: z
    .string()
    .optional()
    .describe('Who you are calling, e.g. "Bella Napoli (restaurant)" or "Dr. Lee\'s office".'),
  task: z
    .string()
    .min(10)
    .describe(
      "What the call should accomplish, in plain language, with every detail needed " +
        '(e.g. "Book a table for 4 this Friday, Oct 16, between 6:30 and 7:30 pm").',
    ),
  on_behalf_of: z
    .object({
      name: z.string().min(1).describe("Name the agent introduces itself on behalf of / books under."),
      details: z
        .record(z.string(), z.string())
        .default({})
        .describe(
          "Facts the agent MAY share if asked (e.g. callback number, email, account number, date of birth). " +
            "Anything not listed here is never shared.",
        ),
    })
    .describe("The person the agent represents."),
  constraints: z
    .array(z.string())
    .default([])
    .describe('Hard rules the agent must not break, e.g. "Do not accept a reservation that requires a deposit".'),
  questions: z
    .array(z.string())
    .default([])
    .describe('Things to ask or find out along the way, e.g. "Is outdoor seating available?".'),
  if_not_possible: z
    .string()
    .optional()
    .describe(
      "What to do if the goal can't be met within the constraints. " +
        "Default: don't commit to anything; collect the alternatives offered and report back.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .describe("Unique key for this request. Retrying with the same key returns the original call instead of dialing again."),
  notify_phone: PhoneNumber.optional().describe("Where to text the result. Defaults to the user's phone from config."),
  skip_preflight: z
    .boolean()
    .default(false)
    .describe("Dial even if the preflight check thinks details are missing. Use only after asking the user."),
});
export type PlaceCallInput = z.infer<typeof PlaceCallInput>;
export type PlaceCallRequest = z.input<typeof PlaceCallInput>;

/** Lifecycle of one call request. Terminal: completed | no_answer | busy | failed | canceled. */
export const CallStatus = z.enum([
  "queued", // stored, not yet sent to AgentPhone
  "dialing", // AgentPhone accepted the call, not answered yet
  "in_progress", // connected and talking
  "analyzing", // call ended; extracting the outcome
  "completed", // outcome available
  "no_answer",
  "busy",
  "failed",
  "canceled",
]);
export type CallStatus = z.infer<typeof CallStatus>;
export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set(["completed", "no_answer", "busy", "failed", "canceled"]);

export const TranscriptTurn = z.object({
  speaker: z.enum(["agent", "other"]),
  text: z.string(),
  at: z.string().optional(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

/** Structured result of a call, extracted from the transcript. Generic across task types. */
export const Outcome = z.object({
  result: z
    .enum(["succeeded", "partially_succeeded", "not_possible", "failed", "no_answer", "voicemail"])
    .describe(
      "succeeded: goal met within all constraints. partially_succeeded: goal met but something asked for is missing. " +
        "not_possible: the other party couldn't do it within the constraints (nothing was committed). " +
        "failed: the call didn't get far enough to know. no_answer / voicemail: never reached a person.",
    ),
  summary: z.string().describe("One or two plain sentences: what happened, written for the user."),
  confirmed: z
    .array(z.object({ item: z.string(), value: z.string() }))
    .describe('Facts the other party explicitly confirmed, e.g. {item: "Time", value: "Fri Oct 16, 7:00 pm"}. Empty if nothing was agreed.'),
  constraint_checks: z
    .array(
      z.object({
        constraint: z.string(),
        status: z.enum(["met", "violated", "unknown"]),
        evidence: z.string().describe("Short quote or paraphrase from the transcript supporting the status."),
      }),
    )
    .describe("One entry per constraint given in the request."),
  answers: z
    .array(z.object({ question: z.string(), answer: z.string().describe('"Not asked" or "Unclear" if no answer.') }))
    .describe("One entry per question given in the request."),
  alternatives_offered: z
    .array(z.string())
    .describe('Options the other party offered that we did not accept, e.g. "8:00 pm Friday".'),
  unresolved: z.array(z.string()).describe("Anything still open the user should know about or act on."),
});
export type Outcome = z.infer<typeof Outcome>;

export const SmsStatus = z.enum(["not_sent", "sent", "failed", "skipped"]);

export const CallView = z.object({
  call_id: z.string(),
  status: CallStatus,
  to: z.string(),
  recipient: z.string().nullable(),
  task: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  end_reason: z.string().nullable().describe("Why the call ended, as reported by the phone provider."),
  error: z.string().nullable(),
  transcript: z.array(TranscriptTurn),
  outcome: Outcome.nullable(),
  sms: z.object({ status: SmsStatus, to: z.string().nullable(), error: z.string().nullable() }),
});
export type CallView = z.infer<typeof CallView>;
