// Words for people. The panel uses the same `text` through --json, so the two always agree.
const MINUTE = 60000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const clock = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

// Today's time alone, or the day first when it's another day.
export function when(ms, now = Date.now()) {
  const date = new Date(ms), today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? clock(date) : `${DAYS[date.getDay()]} ${clock(date)}`;
}

export function forecastText(limit, now) {
  const f = limit.forecast;
  const reset = limit.resetAt ? when(Date.parse(limit.resetAt), now) : null;
  switch (f.state) {
    case "no-reset": return "no reset time known";
    case "reset-passed": return `reset at ${reset}, no reading since`;
    case "at-limit": return `at 100%, resets ${reset}`;
    case "stale": return `no reading for ${duration(f.ageMinutes * MINUTE)}, resets ${reset}`;
    case "few-samples": return `too few samples: ${f.samples} over ${f.spanMinutes}m, needs ${f.neededSamples} over ${f.neededSpanMinutes}m`;
    case "hits": return `hits 100% at ${when(Date.parse(f.hitsAt), now)}, ${duration(f.marginMs)} before reset${f.confidence === "low" ? " (rough)" : ""}`;
    default: return f.burnPerHour > 0 ? `safe until reset, ${reset}` : `no use lately, resets ${reset}`;
  }
}

export const burnText = (limit) => (limit.forecast.burnPerHour === null ? "-" : `${limit.forecast.burnPerHour.toFixed(1)}%/h`);

export const pauseText = (pause, held, now) => {
  if (!pause) return null;
  const until = Date.parse(pause.until ?? "");
  const end = Number.isFinite(until) ? (until > now ? `Paused until ${when(until, now)}` : "Pause ended, not yet resumed") : "Paused until resumed";
  const reason = pause.reason ? ` ${pause.reason.replace(/\.?$/, ".")}` : "";
  const agents = held ? ` ${held} tool call${held === 1 ? "" : "s"} held.` : "";
  return `${end}.${reason}${agents}`;
};

// status --json: the shape the panel reads.
export function statusReply(reading, { pause, held, watching, hook }, now) {
  return {
    now: new Date(now).toISOString(),
    limits: reading.limits.map((limit) => ({
      id: limit.id,
      provider: limit.provider,
      label: limit.label,
      used: limit.used,
      resetAt: limit.resetAt,
      windowMinutes: limit.windowMinutes,
      source: limit.source,
      ageMinutes: Math.round((now - limit.at) / MINUTE),
      burnPerHour: limit.forecast.burnPerHour,
      forecast: limit.forecast,
      samples: limit.samples ?? [],
      text: forecastText(limit, now),
    })),
    pause: pause ?? null,
    pauseText: pauseText(pause, held, now),
    due: Boolean(pause && Number.isFinite(Date.parse(pause.until ?? "")) && Date.parse(pause.until) <= now),
    held,
    watching,
    hook,
    sources: reading.sources,
    notes: reading.notes,
  };
}

const pad = (text, width) => String(text).padEnd(width);

export function statusText(reply) {
  const lines = [];
  const name = Math.max(0, ...reply.limits.map((l) => l.label.length));
  for (const limit of reply.limits) {
    const burn = limit.burnPerHour === null ? "-" : `${limit.burnPerHour.toFixed(1)}%/h`;
    lines.push(`${pad(limit.label, name)}  ${String(Math.round(limit.used)).padStart(3)}%  ${burn.padStart(7)}  ${limit.text}`);
  }
  if (!reply.limits.length) lines.push("No limits found.");
  lines.push("");
  lines.push(reply.pauseText ?? (reply.watching ? "Watching." : "Not paused."));
  if (reply.pause && !reply.hook) lines.push("No Claude Code hook here, so Claude Code agents aren't held. See runway install-hook.");
  const sources = reply.sources.map((s) => `${s.source} ${s.ageMinutes < 1 ? "just now" : `${duration(s.ageMinutes * MINUTE)} old`}`);
  if (sources.length) lines.push(`Read from ${sources.join(", ")}.`);
  for (const note of reply.notes) lines.push(`${note}.`);
  return lines.join("\n");
}
