import type { CallStatus } from "../schemas.ts";
import type { ProviderCall } from "./client.ts";

/** Map AgentPhone's call state onto ours. `null` means the call has ended and needs finalizing. */
export function mapProviderStatus(call: ProviderCall): { status: CallStatus; reason: string | null } | { status: null; reason: string | null } {
  const s = call.status.toLowerCase().replace(/_/g, "-");
  const reason = call.failureReason ?? call.disconnectionReason ?? null;
  const why = `${s} ${reason ?? ""}`.toLowerCase();
  if (/no-?answer|no_answer/.test(why)) return { status: "no_answer", reason };
  if (/busy/.test(why)) return { status: "busy", reason };
  if (["failed", "error", "canceled", "cancelled"].includes(s)) return { status: s.startsWith("cancel") ? "canceled" : "failed", reason };
  if (["queued", "initiated", "ringing", "dialing"].includes(s)) return { status: "dialing", reason };
  if (s === "in-progress" && !call.endedAt) return { status: "in_progress", reason };
  // completed, ended, or anything else with an end time: the conversation is over.
  if (s === "completed" || call.endedAt) return { status: null, reason };
  return { status: "in_progress", reason };
}
