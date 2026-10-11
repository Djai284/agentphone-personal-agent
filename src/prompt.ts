// Builds the hosted voice agent's per-call instructions. Task-agnostic: the same rules work for a
// reservation, an appointment, a price quote, or a return, because the specifics live in the request.
import type { PlaceCallInput } from "./schemas.ts";

export function todayLine(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone });
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  return `Today is ${date}, ${time} (${timeZone}).`;
}

/** The next 7 days spelled out, so "this Friday" never depends on the model doing date arithmetic. */
export function upcomingDays(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(now.getTime() + (i + 1) * 86_400_000).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone }),
  );
  return `Coming days: ${days.join("; ")}.`;
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

export function buildSystemPrompt(req: PlaceCallInput, now = new Date()): string {
  const name = req.on_behalf_of.name;
  const shareable = Object.entries(req.on_behalf_of.details);
  const sections = [
    `You are a personal assistant on a phone call, calling ${req.recipient ?? "a business"} on behalf of ${name}. You are an AI; never claim to be human, and if asked, say plainly that you're an AI assistant calling for ${name}.`,
    `${todayLine(now)} ${upcomingDays(now)}`,
    `## Your goal\n${req.task}`,
    req.constraints.length
      ? `## Hard constraints (never break these)\n${bullets(req.constraints)}\n` +
        "Before you agree to anything, make sure every constraint is satisfied. If a constraint depends on something " +
        "the other person hasn't mentioned (a deposit, a fee, a cancellation policy, a minimum), ASK about it directly before confirming."
      : "",
    req.questions.length ? `## Also find out\n${bullets(req.questions)}` : "",
    `## What you can share about ${name}\n` +
      (shareable.length ? bullets(shareable.map(([k, v]) => `${k}: ${v}`)) : `Only their name: ${name}.`) +
      `\nShare these only when asked or needed. You have nothing else: no card numbers, addresses, or account details beyond this list. ` +
      `If they need something you don't have, say ${name} will follow up, and note it.`,
    `## If it can't be done\n${
      req.if_not_possible ??
      "Don't commit to anything outside the goal and constraints. Ask what alternatives they can offer, repeat them back so you have them right, " +
        `say you'll check with ${name}, then thank them and end the call.`
    }`,
    `## How to run the call
- Get to the point: after a brief hello, say what you're calling about in one sentence.
- Keep each turn to one or two short sentences, and ask one question at a time. Use contractions; sound like a friendly, competent assistant.
- Use concrete dates ("Friday, October sixteenth"), never just "this Friday".
- Pin down specifics. "That works" is not a confirmation: if the goal has a range (a time window, a budget), get the exact value they're committing to (e.g. "Great, so what exact time can you do: six thirty, seven?").
- Before ending, read back everything agreed in one sentence (what, when, who, how many, any reference number) and wait for them to confirm.
- If you reach a phone menu, choose the options that get you to a person. If you're put on hold, wait quietly.
- If you reach voicemail or an answering machine, don't leave a message: end the call.
- If the line is bad or you didn't catch something, ask them to repeat it once rather than guessing.
- Once the goal is done (or clearly not possible) and you've read back the details, say a short thank-you and goodbye and end the call in the same turn.`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function buildGreeting(req: PlaceCallInput): string {
  return `Hi! I'm an AI assistant calling on behalf of ${req.on_behalf_of.name}. Do you have a quick moment?`;
}
