// Stored row → the CallView every app shows. JSON columns are validated on the way out, so a bad
// row fails loudly here instead of somewhere downstream.
import { dashboardCallUrl } from "../agentphone/agent.ts";
import type { Call } from "../db/index.ts";
import { z } from "zod";
import { type CallView, Outcome, type PlaceCallInput, PlaceCallInput as PlaceCallInputSchema, TranscriptTurn } from "../schemas.ts";

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function requestOf(row: Call): PlaceCallInput {
  return PlaceCallInputSchema.parse(row.request);
}

export function toView(row: Call): CallView {
  return {
    call_id: row.id,
    status: row.status,
    source: row.source,
    to: row.toNumber,
    recipient: row.recipient,
    task: row.task,
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    ended_at: iso(row.endedAt),
    duration_seconds: row.durationSeconds,
    end_reason: row.endReason,
    error: row.error,
    transcript: z.array(TranscriptTurn).parse(row.transcript),
    outcome: row.outcome ? Outcome.parse(row.outcome) : null,
    sms: { status: row.smsStatus === "sending" ? "not_sent" : row.smsStatus, to: row.smsTo, error: row.smsError },
    dashboard_url: row.providerCallId ? dashboardCallUrl(row.providerCallId) : null,
  };
}
