// @callagent/core: everything the apps share. Apps import only from here.

export { getConfig, ROOT, type Config } from "./config.ts";
export * from "./schemas.ts";
export { todayLine, upcomingDays } from "./calendar.ts";

// AgentPhone: REST client, status mapping, and what it sends us (webhooks, tool requests).
export { AgentPhone, AgentPhoneError, type CreateCallParams, type ProviderCall, StreamEvent } from "./agentphone/client.ts";
export { mapProviderStatus } from "./agentphone/status.ts";
export { isPersonalNumber, ToolRequest, verifySignature, WebhookEvent } from "./agentphone/webhooks.ts";

// The call lifecycle.
export { CallService, IdempotencyConflict, NotAllowed, type PlaceCallResult, requestHash } from "./calls/service.ts";
export { requestOf, toView } from "./calls/view.ts";

// Claude: understanding requests and grading calls.
export { Intake, IntakeDecision, type ThreadMessage } from "./ai/intake.ts";
export { Preflight, PreflightResult } from "./ai/preflight.ts";
export { deterministicOutcome, OutcomeExtractor } from "./ai/outcome.ts";

// What the voice agent is told.
export { buildGreeting, buildSystemPrompt } from "./voice/outbound.ts";
export { INBOUND_GREETING, inboundSystemPrompt, placeCallTool } from "./voice/inbound.ts";

export { formatResultSms } from "./notify.ts";
