// CLI over the same CallService the MCP server uses: call, status, watch, history, cancel.
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  CallService,
  type CallView,
  formatResultSms,
  getConfig,
  IdempotencyConflict,
  NotAllowed,
  type PlaceCallRequest,
  Preflight,
  TERMINAL_STATUSES,
} from "@callagent/core";
import { z } from "zod";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const collect = (v: string, prev: string[]) => [...prev, v];

function service() {
  return new CallService(getConfig());
}

/** Follow a call: print the live transcript and status changes, then the result. */
async function follow(svc: CallService, callId: string): Promise<CallView> {
  const abort = new AbortController();
  let lastStatus = "";
  let streaming = false;
  const startStream = (providerId: string) => {
    if (streaming) return;
    streaming = true;
    (async () => {
      try {
        for await (const ev of svc.phone.streamTranscript(providerId, abort.signal)) {
          if (ev.event === "turn") console.log(`  ${ev.data.role === "agent" ? bold("agent") : bold(" them")}  ${ev.data.content.trim()}`);
        }
      } catch {
        /* stream is best-effort; the final transcript comes from get_call */
      }
    })();
  };
  const call = await svc.waitForResult(callId, {
    onUpdate: (c) => {
      if (c.status !== lastStatus) console.log(dim(`[${new Date().toLocaleTimeString()}] ${c.status}${c.end_reason ? ` (${c.end_reason})` : ""}`));
      lastStatus = c.status;
      if (c.status === "in_progress" && !streaming) {
        void svc.repo.get(callId).then((row) => row?.providerCallId && startStream(row.providerCallId));
      }
    },
  });
  abort.abort();
  return call;
}

function printResult(call: CallView) {
  console.log(`\n${formatResultSms(call)}`);
  const sms = call.sms.status === "sent" ? `texted to ${call.sms.to}` : `text ${call.sms.status}${call.sms.error ? `: ${call.sms.error}` : ""}`;
  console.log(dim(`\n${call.call_id} · ${call.duration_seconds ?? 0}s · ${sms}`));
}

const program = new Command().name("callagent").description("Have an AI agent make a phone call for you.");

program
  .command("call")
  .description("Place a call (asks for missing details first) and follow it to the result.")
  .option("--file <path>", "Read the request as JSON (same shape as the place_call MCP tool)")
  .option("--to <phone>", "Number to call")
  .option("--recipient <who>", 'Who you are calling, e.g. "Bella Napoli (restaurant)"')
  .option("--task <text>", "What the call should accomplish")
  .option("--name <name>", "Who the agent is calling on behalf of")
  .option("--detail <key=value>", "Shareable detail, e.g. callback=+18605551234 (repeatable)", collect, [])
  .option("--constraint <rule>", "Hard rule (repeatable)", collect, [])
  .option("--ask <question>", "Question to ask (repeatable)", collect, [])
  .option("--key <idempotency-key>", "Idempotency key (default: random)")
  .option("-y, --yes", "Skip the preflight check")
  .option("--no-wait", "Return right after dialing")
  .action(async (opts) => {
    const svc = service();
    const raw: PlaceCallRequest = opts.file
      ? JSON.parse(readFileSync(opts.file, "utf8"))
      : {
          to: opts.to,
          recipient: opts.recipient,
          task: opts.task,
          on_behalf_of: {
            name: opts.name,
            details: Object.fromEntries((opts.detail as string[]).map((d) => d.split(/=(.*)/s).slice(0, 2) as [string, string])),
          },
          constraints: opts.constraint,
          questions: opts.ask,
          idempotency_key: opts.key ?? `cli-${randomUUID()}`,
        };
    if (opts.key) raw.idempotency_key = opts.key;
    if (opts.yes) raw.skip_preflight = true;

    let input;
    try {
      input = svc.parse(raw);
    } catch (err) {
      console.error(err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message);
      process.exitCode = 1;
      return;
    }

    if (!(await svc.existing(input)) && !input.skip_preflight) {
      const config = getConfig();
      const check = await new Preflight(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL).check(input);
      for (const w of check.warnings) console.log(dim(`note: ${w}`));
      if (!check.ready) {
        console.log(bold("A few details first:"));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answers: string[] = [];
        for (const m of check.missing) answers.push(`${m.detail}: ${await rl.question(`  ${m.question} `)}`);
        rl.close();
        input = { ...input, task: `${input.task}\nDetails: ${answers.join("; ")}` };
      }
    }

    try {
      const { kind, call } = await svc.place(input, { source: "cli" });
      console.log(
        kind === "existing"
          ? `Already placed as ${call.call_id} (${call.status}); not dialing again.`
          : `Calling ${call.recipient ?? call.to}… ${dim(`(${call.call_id}, key ${input.idempotency_key})`)}`,
      );
      if (!opts.wait) return;
      printResult(TERMINAL_STATUSES.has(call.status) ? (await svc.refresh(call.call_id))! : await follow(svc, call.call_id));
    } catch (err) {
      if (err instanceof IdempotencyConflict || err instanceof NotAllowed) {
        console.error(err.message);
        process.exitCode = 1;
      } else throw err;
    }
  });

program
  .command("status <call_id>")
  .description("Show a call's status and result.")
  .option("--transcript", "Include the transcript")
  .action(async (id, opts) => {
    const call = await service().refresh(id);
    if (!call) return void console.error(`No call ${id}`);
    console.log(`${bold(call.status)}  ${call.recipient ?? call.to}  ${dim(call.task)}`);
    if (opts.transcript) for (const t of call.transcript) console.log(`  ${t.speaker === "agent" ? "agent" : " them"}  ${t.text.trim()}`);
    if (TERMINAL_STATUSES.has(call.status)) printResult(call);
  });

program
  .command("watch <call_id>")
  .description("Follow a call live until it finishes.")
  .action(async (id) => printResult(await follow(service(), id)));

program
  .command("history")
  .description("Recent calls.")
  .option("-n <count>", "How many", "15")
  .action(async (opts) => {
    for (const c of await service().list(Number(opts.n))) {
      const when = dim(c.created_at.slice(0, 16).replace("T", " "));
      console.log(`${when}  ${c.call_id}  ${c.source.padEnd(5)} ${bold(c.status.padEnd(11))} ${(c.outcome?.result ?? "").padEnd(19)} ${c.recipient ?? c.to}: ${c.task.split("\n")[0]}`);
    }
  });

program
  .command("cancel <call_id>")
  .description("Hang up a call in progress.")
  .action(async (id) => console.log((await service().cancel(id))?.status ?? `No call ${id}`));

await program.parseAsync();
// The database pool would otherwise keep the process alive.
process.exit(process.exitCode ?? 0);
