// The result text. It has to read well on a lock screen: result first, then the facts, then what's open.
import type { CallView, Outcome } from "./schemas.ts";

const RESULT_LABEL: Record<Outcome["result"], string> = {
  succeeded: "✅ Done",
  partially_succeeded: "⚠️ Partly done",
  fallback_succeeded: "✅ Done (backup plan)",
  not_possible: "❌ Couldn't do it",
  failed: "❌ Call didn't finish",
  no_answer: "📵 No answer",
  voicemail: "📵 Got voicemail",
};

const CHECK_MARK = { met: "✓", violated: "✗", unknown: "?" } as const;

function who(call: CallView): string {
  return call.recipient ?? call.to;
}

/**
 * `withDashboardLink` adds the call's AgentPhone dashboard page. Only the account owner can open it,
 * so it's for texts to the owner, not to other people who asked by text or voice.
 */
export function formatResultSms(call: CallView, { withDashboardLink = false } = {}): string {
  const link = withDashboardLink && call.dashboard_url ? `\n\nFull call: ${call.dashboard_url}` : "";
  return resultBody(call) + link;
}

function resultBody(call: CallView): string {
  const o = call.outcome;
  if (!o) {
    const why: Record<string, string> = {
      no_answer: `📵 No answer from ${who(call)}. Nothing was done.`,
      busy: `📵 ${who(call)} was busy. Nothing was done.`,
      canceled: `Call to ${who(call)} was canceled. Nothing was done.`,
      failed: `❌ Couldn't complete the call to ${who(call)}${call.error ? ` (${call.error})` : ""}. Nothing was done.`,
    };
    return `${why[call.status] ?? `Call to ${who(call)} ended: ${call.status}.`}\nTask: ${call.task}`;
  }

  const lines = [`${RESULT_LABEL[o.result]}: ${who(call)}`, o.summary];
  if (o.confirmed.length) lines.push("", "Confirmed:", ...o.confirmed.map((c) => `• ${c.item}: ${c.value}`));
  if (o.constraint_checks.length)
    lines.push("", "Your rules:", ...o.constraint_checks.map((c) => `${CHECK_MARK[c.status]} ${c.constraint}`));
  if (o.answers.length) lines.push("", ...o.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`));
  if (o.alternatives_offered.length) lines.push("", "They offered instead:", ...o.alternatives_offered.map((a) => `• ${a}`));
  if (o.unresolved.length) lines.push("", "Still open:", ...o.unresolved.map((u) => `• ${u}`));
  return lines.join("\n");
}
