// API spike: place one hosted call, poll it to the end, and save every raw payload as a fixture.
// Usage: tsx scripts/spike.ts <to> [label]
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

const API = "https://api.agentphone.ai/v1";
const headers = {
  Authorization: `Bearer ${process.env.AGENTPHONE_API_KEY}`,
  "Content-Type": "application/json",
};
const [to, label = "spike"] = process.argv.slice(2);
if (!to) throw new Error("usage: tsx scripts/spike.ts <to> [label]");

const dir = `test/fixtures/${label}`;
mkdirSync(dir, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(`${dir}/${name}.json`, JSON.stringify(data, null, 2));

const systemPrompt = `You are a polite AI assistant calling a restaurant on behalf of Manav.
Goal: book a table for four this Friday between 6:30 and 7:30 pm under the name Manav. Ask whether outdoor seating is available.
Never accept a reservation that requires a deposit. If no time in the window is available, do not book; thank them and end the call.
Say once, at the start, that you're an AI assistant calling for Manav. Keep each turn to one short sentence.
When the conversation is finished, say a brief goodbye and end the call.`;

const res = await fetch(`${API}/calls`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    agentId: process.env.AGENTPHONE_AGENT_ID,
    fromNumberId: process.env.AGENTPHONE_NUMBER_ID,
    toNumber: to,
    systemPrompt,
    initialGreeting: "Hi! I'm an AI assistant calling on behalf of Manav. Is this a good time to make a reservation?",
  }),
});
const created = await res.json();
save("01-create", { status: res.status, body: created });
console.log("create", res.status, JSON.stringify(created));
const id = created.id ?? created.callId ?? created.data?.id;
if (!id) process.exit(1);

let last = "";
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const call = await (await fetch(`${API}/calls/${id}`, { headers })).json();
  const key = `${call.status}:${call.transcripts?.length ?? 0}`;
  if (key !== last) {
    console.log(new Date().toISOString(), key);
    save(`poll-${String(i).padStart(3, "0")}-${call.status}`, call);
    last = key;
  }
  if (call.endedAt || ["completed", "failed", "no-answer", "busy", "canceled", "ended"].includes(call.status)) break;
}
// Give post-call analysis a moment, then capture the final state and transcript endpoint.
await new Promise((r) => setTimeout(r, 8000));
save("90-final", await (await fetch(`${API}/calls/${id}`, { headers })).json());
const t = await fetch(`${API}/calls/${id}/transcript`, { headers });
save("91-transcript", { status: t.status, body: await t.json().catch(() => null) });
console.log("saved fixtures to", dir);
