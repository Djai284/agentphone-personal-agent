// MCP server (stdio): place_call, get_call, list_calls, cancel_call.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CallService,
  CallStatus,
  CallView,
  formatResultSms,
  getConfig,
  IdempotencyConflict,
  NotAllowed,
  PlaceCallInput,
  Preflight,
  PreflightResult,
  TERMINAL_STATUSES,
} from "@callagent/core";

const config = getConfig();
const service = new CallService(config);
const preflight = new Preflight(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);

const PlaceCallOutput = z.object({
  result: z
    .enum(["placed", "already_placed", "needs_info", "rejected"])
    .describe("placed: dialing now. already_placed: this idempotency key was used before; no new call. needs_info: ask the user, then retry. rejected: see message."),
  call_id: z.string().nullable(),
  status: CallStatus.nullable(),
  message: z.string(),
  preflight: PreflightResult.nullable(),
});

const GetCallOutput = CallView.extend({
  message: z.string().describe("Human-readable status for relaying to the user."),
});

const ListCallsOutput = z.object({
  calls: z.array(
    z.object({ call_id: z.string(), status: CallStatus, recipient: z.string().nullable(), to: z.string(), task: z.string(), created_at: z.string(), result: z.string().nullable() }),
  ),
});

function describe(call: CallView): string {
  switch (call.status) {
    case "queued":
    case "dialing":
      return "Dialing; not answered yet.";
    case "in_progress":
      return "On the call now.";
    case "analyzing":
      return "Call ended; working out the result.";
    default:
      return formatResultSms(call) + (call.sms.status === "sent" ? `\n\n(Result texted to the user at ${call.sms.to}.)` : call.sms.status === "failed" ? `\n\n(Text to the user failed: ${call.sms.error})` : "");
  }
}

function reply<T extends Record<string, unknown>>(data: T, text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], structuredContent: data, isError };
}

const server = new McpServer(
  { name: "personal-call-agent", version: "0.1.0" },
  {
    instructions:
      "Places real phone calls on the user's behalf and reports back. Workflow: gather the details the other party will need " +
      "(for a booking: date, time window, party size, name), call place_call with a fresh idempotency_key, then call get_call " +
      "with wait_seconds until the status is terminal (completed, no_answer, busy, failed, canceled) and relay the outcome. " +
      "If place_call returns needs_info, ask the user those questions and call again with the answers (same idempotency_key is fine). " +
      "Never invent details the user didn't give. The user also gets the result by text.",
  },
);

server.registerTool(
  "place_call",
  {
    title: "Place a phone call",
    description:
      "Phone a person or business and have an AI voice agent complete a task on the user's behalf (book, reschedule, ask, confirm, cancel...). " +
      "Returns a call_id immediately; the call runs in the background. Use get_call to follow it.",
    inputSchema: PlaceCallInput,
    outputSchema: PlaceCallOutput,
    annotations: { openWorldHint: true, idempotentHint: true, destructiveHint: false },
  },
  async (raw) => {
    try {
      const input = service.parse(raw);
      const prior = await service.existing(input);
      if (prior) {
        return reply(
          { result: "already_placed", call_id: prior.call_id, status: prior.status, message: `Already placed as ${prior.call_id} (${prior.status}); no new call was made.`, preflight: null },
          `This request was already placed as ${prior.call_id} (status: ${prior.status}). No new call was made.`,
        );
      }
      let check: PreflightResult | null = null;
      if (!input.skip_preflight) {
        check = await preflight.check(input);
        if (!check.ready) {
          const qs = check.missing.map((m) => `- ${m.question}`).join("\n");
          return reply(
            { result: "needs_info", call_id: null, status: null, message: "Not dialed: details missing.", preflight: check },
            `Not dialed yet. Ask the user:\n${qs}\nThen call place_call again with the answers.`,
          );
        }
      }
      const { kind, call } = await service.place(input, { source: "mcp" });
      const warn = check?.warnings.length ? `\nNote: ${check.warnings.join(" ")}` : "";
      if (call.status === "failed") {
        return reply({ result: "placed", call_id: call.call_id, status: call.status, message: call.error ?? "Dial failed.", preflight: check }, `The call couldn't be placed: ${call.error}`, true);
      }
      return reply(
        { result: kind === "existing" ? "already_placed" : "placed", call_id: call.call_id, status: call.status, message: "Dialing.", preflight: check },
        `Calling ${call.recipient ?? call.to} now (call_id: ${call.call_id}). Use get_call with wait_seconds to follow it.${warn}`,
      );
    } catch (err) {
      if (err instanceof IdempotencyConflict || err instanceof NotAllowed || err instanceof z.ZodError) {
        const message = err instanceof z.ZodError ? z.prettifyError(err) : err.message;
        return reply({ result: "rejected", call_id: null, status: null, message, preflight: null }, message, true);
      }
      throw err;
    }
  },
);

server.registerTool(
  "get_call",
  {
    title: "Get call status and result",
    description:
      "Status, transcript (available once the call ends), and structured outcome of a call. " +
      "Set wait_seconds to wait for the call to change state instead of polling rapidly.",
    inputSchema: {
      call_id: z.string(),
      wait_seconds: z.number().int().min(0).max(50).default(0).describe("Wait up to this long for a status change or the final result."),
    },
    outputSchema: GetCallOutput,
    annotations: { readOnlyHint: true },
  },
  async ({ call_id, wait_seconds }) => {
    let call = await service.refresh(call_id);
    if (!call) return reply({} as never, `No call with id ${call_id}.`, true);
    const start = call.status;
    const deadline = Date.now() + wait_seconds * 1000;
    while (Date.now() < deadline && !TERMINAL_STATUSES.has(call.status) && call.status === start) {
      await new Promise((r) => setTimeout(r, 2000));
      call = (await service.refresh(call_id))!;
    }
    // A terminal call may still be sending its text; give it a moment so the reply is complete.
    while (Date.now() < deadline && TERMINAL_STATUSES.has(call.status) && call.sms.status === "not_sent") {
      await new Promise((r) => setTimeout(r, 1000));
      call = (await service.refresh(call_id))!;
    }
    const message = describe(call);
    return reply({ ...call, message }, `Status: ${call.status}\n${message}`);
  },
);

server.registerTool(
  "list_calls",
  {
    title: "Call history",
    description: "Recent calls, newest first, with their status and result.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
    outputSchema: ListCallsOutput,
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) => {
    const calls = (await service.list(limit)).map((c) => ({
      call_id: c.call_id,
      status: c.status,
      recipient: c.recipient,
      to: c.to,
      task: c.task,
      created_at: c.created_at,
      result: c.outcome?.result ?? null,
    }));
    const text = calls.length
      ? calls.map((c) => `${c.created_at.slice(0, 16)}  ${c.call_id}  ${c.status}${c.result ? `/${c.result}` : ""}  ${c.recipient ?? c.to}: ${c.task}`).join("\n")
      : "No calls yet.";
    return reply({ calls }, text);
  },
);

server.registerTool(
  "cancel_call",
  {
    title: "Hang up a call",
    description: "End a call that is ringing or in progress.",
    inputSchema: { call_id: z.string() },
    outputSchema: GetCallOutput,
    annotations: { destructiveHint: true },
  },
  async ({ call_id }) => {
    const call = await service.cancel(call_id);
    if (!call) return reply({} as never, `No call with id ${call_id}.`, true);
    return reply({ ...call, message: describe(call) }, `Status: ${call.status}`);
  },
);

// Keep in-flight calls moving even when nobody is asking about them, so the SMS always goes out.
service.startReconciler();
await server.connect(new StdioServerTransport());
// Exit with the client; the database pool would otherwise keep an orphaned server running.
process.stdin.on("close", () => process.exit(0));
