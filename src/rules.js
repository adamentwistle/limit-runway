// What watch should do with a reading. Pure, so every rule is tested without a clock or a file.
import { covers, untilMs } from "./pause.js";

const MINUTE = 60000;

export const DEFAULT_RULES = {
  pauseAt: 95,
  forecastMinutes: 30,
  leaveAloneMinutes: 15,
  resumeGraceSeconds: 60,
  maxAgeMinutes: 30,
};

const rulesFor = (id, config) => ({ ...DEFAULT_RULES, ...config, ...(config.limits?.[id] ?? {}) });

// Why this limit calls for a pause, or a word for why not.
export function judge(limit, now, config = {}) {
  const rules = rulesFor(limit.id, config);
  if (rules.ignore) return { fire: false, why: "ignored" };
  const resetMs = limit.resetAt ? Date.parse(limit.resetAt) : NaN;
  if (!Number.isFinite(resetMs)) return { fire: false, why: "no-reset" };
  if (resetMs <= now) return { fire: false, why: "reset-passed" };
  if (resetMs - now <= rules.leaveAloneMinutes * MINUTE) return { fire: false, why: "resets-soon" };

  const at = limit.used >= rules.pauseAt;
  if (at) return { fire: true, why: "threshold", text: `${limit.label} is at ${Math.round(limit.used)}%, past ${rules.pauseAt}%` };

  const f = limit.forecast;
  if (f?.state !== "hits" || f.confidence !== "good") return { fire: false, why: f?.state ?? "no-forecast" };
  if (now - limit.at > rules.maxAgeMinutes * MINUTE) return { fire: false, why: "stale" };
  const lead = Date.parse(f.hitsAt) - now;
  if (lead > rules.forecastMinutes * MINUTE) return { fire: false, why: "hits-later" };
  return { fire: true, why: "forecast", text: `${limit.label} is forecast to hit 100% within ${rules.forecastMinutes} minutes` };
}

const pauseUntil = (limit, config) => new Date(Date.parse(limit.resetAt) + rulesFor(limit.id, config).resumeGraceSeconds * 1000).toISOString();

// A limit someone resumed past stays quiet until its window ends.
const overridden = (limit, overrides) => {
  const until = overrides?.[limit.id];
  return Boolean(until && limit.resetAt && Math.abs(Date.parse(until) - Date.parse(limit.resetAt)) <= 10 * MINUTE);
};

/**
 * @param limits the limits as read, each with its forecast
 * @param pause the pause file's contents or null
 * @returns { action: "none" | "pause" | "extend" | "resume", ... }
 */
export function decide({ limits, pause, now, config = {}, overrides = {} }) {
  const judged = limits.map((limit) => ({ limit, verdict: judge(limit, now, config) }));
  const firing = judged.filter(({ limit, verdict }) => verdict.fire && !overridden(limit, overrides));

  // The pause lasts until the furthest reset of everything calling for it.
  const furthest = firing.reduce((best, { limit }) => (!best || Date.parse(limit.resetAt) > Date.parse(best.resetAt) ? limit : best), null);
  const providers = [...new Set(firing.map(({ limit }) => limit.provider))];
  const reasons = firing.map(({ verdict }) => verdict.text);

  if (!pause) {
    if (!firing.length) return { action: "none", judged };
    return { action: "pause", judged, until: pauseUntil(furthest, config), providers, reasons, limits: firing.map(({ limit }) => limit.id) };
  }

  const until = untilMs(pause);
  if (pause.by === "watch" || pause.by === undefined) {
    const later = furthest && (until === null || Date.parse(pauseUntil(furthest, config)) > until);
    const wider = providers.some((provider) => !covers(pause, provider));
    if (later || wider) {
      const merged = [...new Set([...(pause.providers ?? []), ...providers])];
      return { action: "extend", judged, until: later ? pauseUntil(furthest, config) : pause.until, providers: merged, reasons, limits: firing.map(({ limit }) => limit.id) };
    }
  }
  if (until !== null && now >= until) return { action: "resume", judged };
  return { action: "none", judged };
}
