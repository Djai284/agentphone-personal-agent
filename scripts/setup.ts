// `npm run setup`: everything after `npm install`, in one re-runnable command.
//   1. .env: creates it and asks for anything missing
//   2. checks the AgentPhone and Anthropic keys
//   3. Postgres: starts it in Docker if needed, applies migrations
//   4. AgentPhone: finds or creates the agent, attaches a texting-capable number, routes its calls
// Safe to run again: it reuses what exists and only changes what's missing.
import { AGENT_NAME, AGENT_SETTINGS, AgentPhone, DEFAULT_DATABASE_URL, getConfig, PhoneNumber, ROOT } from "@callagent/core";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline/promises";
import { config as loadEnv } from "dotenv";

const ENV = `${ROOT}.env`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const step = (s: string) => console.log(`\n${bold(s)}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });

function fail(message: string): never {
  console.error(`\n  \x1b[31m✗\x1b[0m ${message}\n`);
  process.exit(1);
}

/** Set KEY=value in .env, replacing an existing line or appending one. */
function setEnv(key: string, value: string) {
  const text = readFileSync(ENV, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(ENV, re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`);
  process.env[key] = value;
}

async function ask(question: string, validate: (v: string) => string | null = () => null): Promise<string> {
  if (!process.stdin.isTTY) fail(`${question.trim().replace(/:$/, "")}: set it in .env (no terminal to ask in).`);
  for (;;) {
    const answer = (await rl.question(`  ${question} `)).trim();
    const problem = answer ? validate(answer) : "Required.";
    if (!problem) return answer;
    console.log(`    ${problem}`);
  }
}

const portOpen = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: 1500 }, () => (socket.end(), resolve(true)));
    socket.on("error", () => resolve(false)).on("timeout", () => (socket.destroy(), resolve(false)));
  });

// ── 1. .env ──────────────────────────────────────────────────────────────────
step("1. Settings (.env)");
const [major] = process.versions.node.split(".").map(Number);
if (major! < 24) fail(`Node 24+ is required (you have ${process.versions.node}).`);
if (!existsSync(ENV)) {
  copyFileSync(`${ROOT}.env.example`, ENV);
  ok("created .env from .env.example");
}
loadEnv({ path: ENV, quiet: true, override: true });

if (!process.env.AGENTPHONE_API_KEY) setEnv("AGENTPHONE_API_KEY", await ask("AgentPhone API key (dashboard → API keys):"));
if (!process.env.ANTHROPIC_API_KEY) setEnv("ANTHROPIC_API_KEY", await ask("Anthropic API key (console.anthropic.com → API keys):"));
if (!process.env.USER_PHONE) {
  const raw = await ask("Your mobile number (results of MCP/CLI calls are texted here):", (v) =>
    PhoneNumber.safeParse(v).success ? null : "That doesn't look like a phone number.",
  );
  setEnv("USER_PHONE", PhoneNumber.parse(raw));
}
ok("required settings present");

// ── 2. Keys ──────────────────────────────────────────────────────────────────
step("2. API keys");
const phone = new AgentPhone(process.env.AGENTPHONE_API_KEY!);
const agents = await phone.listAgents().catch((err: Error) => fail(`AgentPhone rejected the key: ${err.message}`));
ok("AgentPhone key works");
await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }).models
  .list({ limit: 1 })
  .catch((err: Error) => fail(`Anthropic rejected the key: ${err.message}`));
ok("Anthropic key works");

// ── 3. Database ──────────────────────────────────────────────────────────────
step("3. Database");
const dbUrl = new URL(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
if (!(await portOpen(dbUrl.hostname, Number(dbUrl.port || 5432)))) {
  if (dbUrl.href === new URL(DEFAULT_DATABASE_URL).href) {
    console.log("  starting Postgres in Docker…");
    try {
      execSync("docker compose up -d --wait postgres", { cwd: ROOT, stdio: "inherit" });
    } catch {
      fail("Couldn't start Postgres with Docker. Is Docker running? (Or set DATABASE_URL to a Postgres you already have.)");
    }
  } else {
    fail(`Can't reach Postgres at ${dbUrl.host}. Check DATABASE_URL.`);
  }
}
ok(`Postgres reachable at ${dbUrl.host}`);
execSync("npx prisma migrate deploy", { cwd: `${ROOT}packages/core`, stdio: "pipe", env: process.env });
ok("migrations applied");

// ── 4. AgentPhone agent + number ─────────────────────────────────────────────
step("4. AgentPhone agent and number");
let agent =
  agents.data.find((a) => a.id === process.env.AGENTPHONE_AGENT_ID) ?? agents.data.find((a) => a.name === AGENT_NAME);
if (agent) {
  ok(`using agent "${agent.name}" (${agent.id})`);
} else {
  agent = await phone.createAgent(AGENT_SETTINGS);
  ok(`created agent "${agent.name}" (${agent.id})`);
}
setEnv("AGENTPHONE_AGENT_ID", agent.id);

const numbers = (await phone.listNumbers()).data;
const canText = numbers.filter((n) => n.outboundSms === "enabled");
let number =
  numbers.find((n) => n.id === process.env.AGENTPHONE_NUMBER_ID) ??
  canText.find((n) => n.agentId === agent.id) ??
  (canText.length === 1 ? canText[0] : undefined);
if (!number && canText.length > 1) {
  canText.forEach((n, i) => console.log(`    ${i + 1}. ${n.phoneNumber}${n.agentId ? ` (used by agent ${n.agentId})` : ""}`));
  const pick = await ask("Which number should the agent call and text from?", (v) =>
    Number(v) >= 1 && Number(v) <= canText.length ? null : `Pick 1–${canText.length}.`,
  );
  number = canText[Number(pick) - 1];
}
if (!number) {
  fail(
    numbers.length
      ? `None of your numbers can send texts yet (outbound SMS: ${numbers.map((n) => `${n.phoneNumber} ${n.outboundSms}`).join(", ")}). ` +
          "Complete SMS registration for one in the AgentPhone dashboard, then run this again."
      : "Your AgentPhone account has no phone numbers. Get one in the dashboard (Numbers → Buy), then run this again.",
  );
}
if (number.outboundSms !== "enabled") console.log(`  ! ${number.phoneNumber} can't send texts yet (outbound SMS: ${number.outboundSms}); calls will work, result texts won't.`);
if (number.agentId !== agent.id) {
  if (number.agentId) {
    const answer = await ask(`${number.phoneNumber} belongs to another agent (${number.agentId}). Move it to "${AGENT_NAME}"? (y/n)`);
    if (!/^y/i.test(answer)) fail("Left the number where it is. Set AGENTPHONE_NUMBER_ID to a different number, or move it later.");
  }
  await phone.attachNumber(agent.id, number.id);
  ok(`attached ${number.phoneNumber} to the agent`);
}
if (number.voiceRouting?.method !== "agent") {
  await phone.routeVoiceToAgent(number.id);
  ok(`routed ${number.phoneNumber}'s incoming calls to the agent`);
}
setEnv("AGENTPHONE_NUMBER_ID", number.id);
ok(`agent number: ${bold(number.phoneNumber)}`);

// ── Done ─────────────────────────────────────────────────────────────────────
getConfig(); // validates the finished .env
rl.close();
const tsx = `${ROOT}node_modules/.bin/tsx`;
console.log(`
${bold("Ready.")} Your agent's number is ${bold(number.phoneNumber)}.

  ${bold("Claude Code")}   run \`claude\` in this folder; it picks up .mcp.json (approve "personal-call-agent")
                elsewhere: claude mcp add personal-call-agent -- ${tsx} ${ROOT}apps/mcp/src/index.ts
  ${bold("Claude Desktop")} add to claude_desktop_config.json → "mcpServers":
                "personal-call-agent": { "command": "${tsx}", "args": ["${ROOT}apps/mcp/src/index.ts"] }
  ${bold("Text / call")}   npm run server   (then text or call ${number.phoneNumber})
`);
