// Dates spelled out for the models, so none of them has to do weekday arithmetic.

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
