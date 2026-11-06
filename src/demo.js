// Made-up limits for `--demo` and the panel's preview. Nothing here comes from a real account, and it is never written to
// the history. The curves match the panel's own demo.js, and a test holds the two together.
import { forecast } from "./forecast.js";
import { series } from "./sample.js";

const MINUTE = 60000;
const DAY = 1440;
const iso = (ms) => new Date(ms).toISOString();

// [minute into the window, percent used]: bursts of work with lulls between.
export const CLAUDE_SESSION = [[0, 0], [10, 5], [22, 15], [34, 20], [46, 28], [58, 31], [66, 37], [72, 38], [82, 43], [88, 44], [96, 47], [104, 48.5], [112, 53], [118, 54.5], [126, 57], [140, 61], [152, 68], [160, 70], [172, 76], [184, 79], [196, 85], [208, 87], [220, 92], [228, 93.5], [236, 96]];
const CODEX_SESSION = [[0, 0], [30, 2], [64, 3], [100, 7], [126, 9], [180, 12], [236, 16]];
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

const rows = (id, now, used, elapsed, step, span = elapsed) => {
  const out = [];
  for (let m = elapsed; m >= elapsed - span; m -= step) out.unshift({ id, t: now - (elapsed - m) * MINUTE, used: Math.round(used(m) * 10) / 10 });
  return out;
};

export function demoStatus(now, state = "watching") {
  const paused = state === "paused";
  const elapsed = paused ? 236 : 126;
  const session = { windowMinutes: 300, resetIn: 300 - elapsed, elapsed, step: 3 };
  const defs = [
    { ...session, id: "claude.session", provider: "claude", label: "Claude 5-hour", used: (m) => along(CLAUDE_SESSION, m) },
    { id: "claude.weekly", provider: "claude", label: "Claude weekly", windowMinutes: 7 * DAY, resetIn: 3 * DAY + 310, elapsed: 7 * DAY - (3 * DAY + 310), step: 120, used: weekly },
    { ...session, id: "codex.5-hour", provider: "codex", label: "Codex 5-hour", used: (m) => along(CODEX_SESSION, m) },
    { id: "codex.weekly", provider: "codex", label: "Codex weekly", windowMinutes: 7 * DAY, resetIn: 6.5 * DAY, elapsed: DAY / 2, step: 2, span: 4, used: () => 7 },
  ];
  const limits = defs.map((def) => {
    const resetMs = Math.floor((now + def.resetIn * MINUTE) / MINUTE) * MINUTE;
    const history = rows(def.id, now, def.used, def.elapsed, def.step, def.span).map((row) => ({ ...row, resetAt: iso(resetMs) }));
    const limit = { id: def.id, provider: def.provider, label: def.label, windowMinutes: def.windowMinutes, used: history.at(-1).used, resetAt: iso(resetMs), at: now, source: "demo" };
    return { ...limit, samples: series(history), forecast: forecast(limit, history, now) };
  });
  const reset = Date.parse(limits[0].resetAt);
  return {
    at: now,
    limits,
    sources: [{ source: "demo", ageMinutes: 0 }],
    notes: [],
    pause: paused ? { by: "watch", reason: "Claude 5-hour is forecast to hit 100% within 30 minutes", providers: ["claude"], since: iso(now - 12 * MINUTE), until: iso(reset + MINUTE), herdr: [{ address: "t4" }] } : null,
    held: paused ? 2 : 0,
  };
}
