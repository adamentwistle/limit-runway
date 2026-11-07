// Made-up limits, so the panel can be seen with no CLI and no account. props { "demo": true }, or one of "paused", "confirm",
// "safe", "limit", "few" and "stale". The curves match the CLI's src/demo.js, and a test holds the two together.
const MINUTE = 60000;
const DAY = 1440;
const iso = (ms) => new Date(ms).toISOString();

// [minute into the window, percent used]: bursts of work with lulls between.
export const CLAUDE_SESSION = [[0, 0], [10, 5], [22, 15], [34, 20], [46, 28], [58, 31], [66, 37], [72, 38], [82, 43], [88, 44], [96, 47], [104, 48.5], [112, 53], [118, 54.5], [126, 57], [140, 61], [152, 68], [160, 70], [172, 76], [184, 79], [196, 85], [208, 87], [220, 92], [228, 93.5], [236, 96]];
const CODEX_SESSION = [[0, 0], [30, 2], [64, 3], [100, 7], [126, 9], [180, 12], [236, 16]];
const CALM_SESSION = [[0, 0], [16, 5], [40, 9], [64, 16], [92, 21], [126, 31]];
const FULL_SESSION = [...CLAUDE_SESSION, [248, 100], [262, 100]];
const WORK_DAYS = [12, 9, 15, 7];

const along = (points, minute) => {
  for (let i = 1; i < points.length; i++) {
    const [fromAt, from] = points[i - 1], [toAt, to] = points[i];
    if (minute <= toAt) return from + ((to - from) * (minute - fromAt)) / (toAt - fromAt);
  }
  return points.at(-1)[1];
};

// A weekly limit climbs through each working day and rests overnight.
const weekly = (minute) => WORK_DAYS.reduce((used, day, i) => used + day * Math.min(1, Math.max(0, (minute - i * DAY - 180) / 600)), 0);

const samples = (now, used, elapsed, step, span = elapsed) => {
  const out = [];
  for (let m = elapsed; m >= elapsed - span; m -= step) out.unshift({ t: now - (elapsed - m) * MINUTE, used: Math.round(used(m) * 10) / 10 });
  return out;
};

function limit(now, { id, label, windowMinutes, elapsed, step, span, used, forecast }) {
  const series = samples(now, used, elapsed, step, span);
  return { id, label, windowMinutes, used: series.at(-1).used, resetAt: iso(now + (windowMinutes - elapsed) * MINUTE), samples: series, forecast };
}

const safe = (burnPerHour) => ({ state: "safe", burnPerHour });
const few = { state: "few-samples", burnPerHour: null };
const hits = (now, minutes, burnPerHour) => ({ state: "hits", burnPerHour, hitsAt: iso(now + minutes * MINUTE) });

const claudeWeekly = { label: "Claude weekly", windowMinutes: 7 * DAY, elapsed: 3 * DAY + 1130, step: 120, used: weekly, forecast: safe(0.33) };
const codexWeekly = { label: "Codex weekly", windowMinutes: 7 * DAY, elapsed: DAY / 2, step: 2, span: 4, used: () => 7 };

// Each scene: the minutes into the 5-hour window, and how the limits read there.
const SCENES = {
  watching: (now) => [
    { label: "Claude 5-hour", elapsed: 126, used: (m) => along(CLAUDE_SESSION, m), forecast: hits(now, 126, 20.43) },
    claudeWeekly,
    { label: "Codex 5-hour", elapsed: 126, used: (m) => along(CODEX_SESSION, m), forecast: safe(5.8) },
    { ...codexWeekly, forecast: few },
  ],
  paused: (now) => [
    { label: "Claude 5-hour", elapsed: 236, used: (m) => along(CLAUDE_SESSION, m), forecast: hits(now, 13, 19.13) },
    claudeWeekly,
    { label: "Codex 5-hour", elapsed: 236, used: (m) => along(CODEX_SESSION, m), forecast: safe(4.3) },
    { ...codexWeekly, forecast: few },
  ],
  safe: () => [
    { label: "Claude 5-hour", elapsed: 126, used: (m) => along(CALM_SESSION, m), forecast: safe(12.4) },
    claudeWeekly,
    { label: "Codex 5-hour", elapsed: 126, used: (m) => along(CODEX_SESSION, m), forecast: safe(5.8) },
  ],
  limit: (now) => [
    { label: "Claude 5-hour", elapsed: 262, used: (m) => along(FULL_SESSION, m), forecast: { state: "at-limit", burnPerHour: null, hitsAt: iso(now) } },
    claudeWeekly,
    { ...codexWeekly, forecast: few },
  ],
  stale: () => [
    { ...claudeWeekly, used: (m) => weekly(m) * 1.4, forecast: { state: "stale", burnPerHour: null, ageMinutes: 300 } },
    { label: "Codex weekly", windowMinutes: 7 * DAY, elapsed: 2 * DAY, step: 3, span: 18, used: (m) => 12 - (2 * DAY - m) / 18, forecast: { state: "stale", burnPerHour: null, ageMinutes: 480 } },
  ],
  few: () => [
    { label: "Claude 5-hour", elapsed: 126, step: 2, span: 2, used: () => 41, forecast: few },
    { ...codexWeekly, forecast: few },
  ],
};

export function demoReply(now, scene = "watching") {
  const paused = scene === "paused";
  const limits = (SCENES[scene] ?? SCENES.watching)(now).map((def) => ({ provider: def.label.split(" ")[0].toLowerCase(), ...limit(now, { id: def.label.toLowerCase(), windowMinutes: 300, step: 3, ...def }) }));
  const until = Date.parse(limits[0].resetAt) + MINUTE;
  const reason = "Claude 5-hour is forecast to hit 100% within 30 minutes";
  return {
    now: iso(now),
    limits,
    pause: paused ? { by: "watch", reason, until: iso(until) } : null,
    pauseText: paused ? `Paused until ${new Date(until).toTimeString().slice(0, 5)}. ${reason}. 2 tool calls held.` : null,
    due: false,
    watching: true,
    notes: [],
  };
}
