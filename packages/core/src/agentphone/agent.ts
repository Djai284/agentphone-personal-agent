// The AgentPhone agent this project runs on. `npm run setup` creates it with these settings; calls
// override the prompt per call, and `npm run server` swaps in the incoming-call prompt and tool.

export const AGENT_NAME = "Personal Call Agent";

/** What a caller hears when nothing is serving incoming calls (`npm run server` isn't running). */
export const OFFLINE_PROMPT =
  "You are a personal assistant line that is currently offline. Say the assistant is offline right now and to try again later, then end the call.";

export const AGENT_SETTINGS = {
  name: AGENT_NAME,
  description: "Places calls on someone's behalf (MCP, text, or voice requests) and texts them the result.",
  // AgentPhone runs the conversation with its built-in LLM; each call sends its own prompt.
  voiceMode: "hosted",
  // The voice agent must never text the person it's calling; result texts are sent by our code.
  enableMessaging: false,
  modelTier: "balanced",
  systemPrompt: OFFLINE_PROMPT,
  voice: "cartesia-Cleo",
  // Never leave a voicemail on someone's behalf.
  voicemailMessage: null,
  // Names, times, and confirmation numbers matter more than a few ms of latency.
  sttMode: "accurate",
  // End dead calls after 30s of silence instead of the 10-minute default.
  maxSilenceMs: 30_000,
  language: "en-US",
} as const;
