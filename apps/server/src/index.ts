// `npm run server`: let the user text or call the agent. Starts the webhook/tool server, opens a
// cloudflared quick tunnel, and points the AgentPhone agent at it. Ctrl-C disconnects the agent again.
import { CallService, getConfig, INBOUND_GREETING, inboundSystemPrompt, OFFLINE_PROMPT, placeCallTool } from "@callagent/core";
import { randomBytes } from "node:crypto";
import { PhoneServer } from "./server.ts";
import { openTunnel, waitUntilReachable } from "./tunnel.ts";

const config = getConfig();
const service = new CallService(config);
const toolSecret = randomBytes(24).toString("hex");
const phoneServer = new PhoneServer(config, service, toolSecret);
let stopping = false;

await phoneServer.listen(config.PORT);
console.log(`server on http://localhost:${config.PORT}`);

const publicUrl = await openTunnel(config.PORT, () => stopping);
console.log(`tunnel ${publicUrl}`);
await waitUntilReachable(`${publicUrl}/health`);

const hook = await service.phone.setAgentWebhook(config.AGENTPHONE_AGENT_ID, `${publicUrl}/webhooks/agentphone`);
phoneServer.setWebhookSecret(hook.secret ?? null);
if (!hook.secret) console.warn("warning: AgentPhone returned no webhook secret; signatures won't be checked");

await service.phone.updateAgent(config.AGENTPHONE_AGENT_ID, {
  systemPrompt: inboundSystemPrompt(),
  beginMessage: INBOUND_GREETING,
  customTools: [placeCallTool(publicUrl, toolSecret)],
});
service.startReconciler();

console.log(`\nReady. Anyone can text or call the agent's number now. Ctrl-C to stop.\n`);

async function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("\ndisconnecting the agent…");
  // The tunnel URL dies with this process, so remove the tool rather than leave it pointing nowhere.
  await service.phone
    .updateAgent(config.AGENTPHONE_AGENT_ID, {
      customTools: null,
      systemPrompt: OFFLINE_PROMPT,
      beginMessage: null,
    })
    .catch((err: unknown) => console.error(`couldn't reset the agent: ${(err as Error).message}`));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
