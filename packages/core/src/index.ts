// @callagent/core: everything the apps share. Apps import only from here.

export { getConfig, ROOT, type Config } from "./config.ts";
export * from "./schemas.ts";
export { todayLine, upcomingDays } from "./calendar.ts";

// AgentPhone: REST client, status mapping, and what it sends us (webhooks, tool requests).
export { Agent, AgentPhone, AgentPhoneError, type CreateCallParams, PhoneNumberInfo, type ProviderCall } from "./agentphone/client.ts";
export { AGENT_NAME, AGENT_SETTINGS, dashboardCallUrl, OFFLINE_PROMPT } from "./agentphone/agent.ts";
export { mapProviderStatus } from "./agentphone/status.ts";
export { isPersonalNumber, ToolRequest, verifySignature, WebhookEvent } from "./agentphone/webhooks.ts";

// Postgres (Prisma).
export { type Call, CallRepository, createDb, DEFAULT_DATABASE_URL } from "./db/index.ts";

// The call lifecycle.
export { CallService, IdempotencyConflict, NotAllowed, type PlaceCallResult, requestHash } from "./calls/service.ts";
export { requestOf, toView } from "./calls/view.ts";

// Claude: understanding requests and grading calls.
export { Intake, IntakeDecision, type ThreadMessage } from "./ai/intake.ts";
export { Preflight, PreflightResult } from "./ai/preflight.ts";
export { describeRequest, deterministicOutcome, OutcomeExtractor } from "./ai/outcome.ts";

// What the voice agent is told.
export { buildGreeting, buildSystemPrompt } from "./voice/outbound.ts";
export { INBOUND_GREETING, inboundSystemPrompt, placeCallTool } from "./voice/inbound.ts";

export { formatResultSms } from "./notify.ts";
